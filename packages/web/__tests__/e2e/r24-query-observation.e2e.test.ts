import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import {
  createDualWriteRepositories,
  createRepositories,
  createSessionDualWriteBridge,
  createSessionEventBus,
  createSessionEventStore,
  createWriteQueue,
  openTekonDatabase,
} from '@tekon/core';
import { test, expect } from './shared-fixture.js';
import { createScopedFixtureRun } from '../fixtures/session-run.js';
import {
  holdSessionListResponses,
  listPublications,
  observeListPublications,
  observeWorkspaceReads,
  settleBrowser,
  STALE_LIST_ERROR,
  workspaceReads,
} from './r24-query-observation-helper.js';

function openObservationStore(projectRoot: string) {
  const db = openTekonDatabase({
    filename: join(projectRoot, '.tekon', 'tekon.sqlite'),
  });
  const queue = createWriteQueue();
  const sessions = createSessionEventStore(db, queue);
  const repositories = createDualWriteRepositories(
    createRepositories(db, queue),
    createSessionDualWriteBridge({
      sessions,
      // 独立入口有独立的进程内 bus；Web 必须通过真实 SQLite catch-up 读到事件。
      bus: createSessionEventBus(),
      onError(error) {
        throw error;
      },
    }),
  );
  return { db, sessions, repositories };
}

type ObservationStore = ReturnType<typeof openObservationStore>;

async function createListSession(store: ObservationStore, projectRoot: string) {
  const workspace = await store.sessions.getOrCreateDefaultWorkspace(projectRoot);
  const session = await store.sessions.createSession({
    workspaceId: workspace.id,
    title: 'R24 列表观察目标',
    profile: 'human-web',
    runId: createScopedFixtureRun(store.db, 'r24_observed_run'),
  });
  await store.sessions.updateSessionStatus(session.id, 'active');
  return session;
}

async function readRpc<Result>(
  page: Page,
  baseUrl: string,
  token: string,
  path: string,
  input?: Record<string, unknown>,
): Promise<Result> {
  const response = await page.request.post(`${baseUrl}/api/rpc`, {
    headers: { 'x-session-token': token },
    data: { path, input },
  });
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as { result: Result; error?: unknown };
  expect(body.error).toBeUndefined();
  return body.result;
}

const workspaceStreamPath = /\/api\/workspaces\/[^/]+\/summary\/events$/u;

interface ObservedStream {
  response: ServerResponse;
  upstream: IncomingMessage;
  closed: boolean;
  frames: number;
}

/**
 * 只透传真实 HTTP 与 SSE 字节。断线测试关闭已建立的两端 socket，暂扣下一次
 * 握手，给 SQLite 写入留出确定窗口；不伪造事件、连接状态或业务响应。
 */
async function createStreamProxy(upstreamUrl: string) {
  const streams: ObservedStream[] = [];
  const waiting = new Set<() => void>();
  let holdConnections = false;
  const proxy = createServer((request, response) => {
    const isWorkspaceStream = workspaceStreamPath.test(request.url ?? '');
    const forward = () => {
      if (response.destroyed) return;
      const upstreamRequest = httpRequest(
        new URL(request.url ?? '/', upstreamUrl),
        {
          method: request.method,
          // 保留浏览器可见 Host，使生产 Origin 校验仍检查同一真实入口。
          headers: request.headers,
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          response.flushHeaders();
          if (isWorkspaceStream && upstreamResponse.statusCode === 200) {
            const stream: ObservedStream = {
              response,
              upstream: upstreamResponse,
              closed: false,
              frames: 0,
            };
            streams.push(stream);
            let pending = '';
            upstreamResponse.on('data', (chunk: Buffer) => {
              pending += chunk.toString('utf8');
              let boundary: number;
              while ((boundary = pending.indexOf('\n\n')) !== -1) {
                const frame = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                if (/^data:/mu.test(frame)) stream.frames++;
              }
            });
            response.once('close', () => {
              stream.closed = true;
            });
          }
          upstreamResponse.once('error', () => response.destroy());
          upstreamResponse.pipe(response);
        },
      );
      upstreamRequest.once('error', () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      response.once('close', () => upstreamRequest.destroy());
      request.pipe(upstreamRequest);
    };
    if (isWorkspaceStream && holdConnections) {
      waiting.add(forward);
      response.once('close', () => waiting.delete(forward));
    } else {
      forward();
    }
  });
  await new Promise<void>((resolve, reject) => {
    proxy.once('error', reject);
    proxy.listen(0, '127.0.0.1', () => {
      proxy.off('error', reject);
      resolve();
    });
  });
  const address = proxy.address();
  if (!address || typeof address === 'string') throw new Error('测试代理未监听 TCP');
  return {
    url: `http://127.0.0.1:${address.port}`,
    streams,
    get waitingConnections() {
      return waiting.size;
    },
    disconnectWorkspace() {
      holdConnections = true;
      const active = streams.filter((stream) => !stream.closed);
      for (const stream of active) {
        stream.upstream.destroy();
        stream.response.destroy();
      }
      return active.length;
    },
    releaseConnections() {
      holdConnections = false;
      for (const forward of waiting) forward();
      waiting.clear();
    },
    async close() {
      waiting.clear();
      for (const stream of streams) {
        stream.upstream.destroy();
        stream.response.destroy();
      }
      proxy.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        proxy.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

test('R24：真实 Workspace 流断开期间发生变更，重连后没有下一事件也追平列表', async ({
  page,
  server,
  fixture,
}) => {
  const store = openObservationStore(fixture.projectRoot);
  const proxy = await createStreamProxy(server.url);
  try {
    const session = await createListSession(store, fixture.projectRoot);
    await page.goto(`${proxy.url}/#token=${encodeURIComponent(fixture.sessionToken)}`);
    const row = page.locator('li.session-list-item').filter({ hasText: session.title! });
    await expect(row).toBeVisible();
    await expect(row.locator('.session-list-action-failed')).toHaveCount(0);
    await expect.poll(() => proxy.streams.filter((stream) => !stream.closed).length).toBe(1);

    // 已有真实列表与已打开的 SSE。必须先证实 socket 关闭且重试被扣住，再变更数据。
    const original = proxy.streams.at(-1)!;
    expect(proxy.disconnectWorkspace()).toBe(1);
    await expect.poll(() => original.closed).toBe(true);
    await expect.poll(() => proxy.waitingConnections).toBe(1);
    await store.sessions.updateSessionStatus(session.id, 'failed');
    const persisted = await readRpc<{ session: { status: string } }>(
      page, server.url, fixture.sessionToken, 'session.get', { sessionId: session.id },
    );
    expect(persisted.session.status).toBe('failed');
    await expect(row.locator('.session-list-action-failed')).toHaveCount(0);

    const reconnectResponse = page.waitForResponse((response) =>
      workspaceStreamPath.test(new URL(response.url()).pathname) && response.status() === 200,
    );
    proxy.releaseConnections();
    await reconnectResponse;
    await expect.poll(() => proxy.streams.length).toBe(2);
    await expect(row.locator('.session-list-action-failed')).toHaveText('需处理', {
      timeout: 8_000,
    });
    // 新连接只建立签名基线；这个更新不能依赖再制造一个 workspace/summary。
    expect(proxy.streams[1].frames).toBe(0);
    expect(proxy.streams[1].closed).toBe(false);
  } finally {
    await proxy.close();
    store.db.close();
  }
});

async function createPendingApproval(store: ObservationStore, id: string) {
  const createdAt = new Date().toISOString();
  const nodeId = `${id}_node`;
  const gateId = `${id}_gate`;
  await store.repositories.createNode({
    id: nodeId,
    runId: 'run_1',
    phaseId: 'phase_1',
    role: 'reviewer',
    status: 'paused',
    gates: [{ type: 'human', gateKey: '00:human', requiresHumanApproval: true }],
    dependencies: [],
    createdAt,
    updatedAt: createdAt,
  });
  await store.repositories.recordGateResult({
    id: gateId,
    runId: 'run_1',
    nodeId,
    gateType: 'human',
    gateKey: '00:human',
    status: 'blocked',
    durationMs: 0,
    retries: 0,
    createdAt,
  });
  await store.repositories.createHumanDecision({
    id,
    runId: 'run_1',
    nodeId,
    gateResultId: gateId,
    status: 'pending',
    note: `request: R24 审批 ${id}\nrisk: low`,
    createdAt,
  });
}

for (const change of ['decided', 'requested'] as const) {
  test(`R24：另一入口 ${change} 时仍有待审批，Session 卡片自动反映 Gate 事实`, async ({
    page,
    server,
    fixture,
  }) => {
    const store = openObservationStore(fixture.projectRoot);
    try {
      const workspace = await store.sessions.getOrCreateDefaultWorkspace(fixture.projectRoot);
      const session = await store.sessions.createSession({
        workspaceId: workspace.id,
        title: 'R24 跨入口审批观察',
        profile: 'human-web',
        runId: 'run_1',
      });
      await store.sessions.updateSessionStatus(session.id, 'awaiting-approval');
      await store.sessions.appendEvent({
        sessionId: session.id,
        type: 'approval/requested',
        payload: { runId: 'run_1', nodeId: 'node_1', decisionId: 'decision_1' },
      });
      await createPendingApproval(store, 'r24_kept_pending');

      await page.goto(`${server.url}/sessions/${session.id}`);
      const approvals = page.getByTestId('session-approvals');
      const card = (id: string) => approvals.locator('.approval-card').filter({
        has: page.locator('.approval-header').getByText(id, { exact: true }),
      });
      await expect(card('decision_1')).toBeVisible();
      await expect(card('r24_kept_pending')).toBeVisible();
      await expect(page.locator('.session-conn-live')).toBeVisible();
      await expect(page.locator('[data-event-type="approval/requested"]')).toHaveCount(2);

      if (change === 'decided') {
        // 真实第二入口 RPC；reject 不启动 Provider 或恢复 Job。
        const result = await readRpc<{ decision: { id: string; status: string } }>(
          page, server.url, fixture.sessionToken, 'gate.reject', {
            runId: 'run_1',
            decisionId: 'decision_1',
            token: fixture.sessionToken,
            actor: 'r24-other-entry',
            note: '由另一入口完成审阅',
          },
        );
        expect(result.decision.status).toBe('rejected');
        await expect(page.locator('[data-event-type="approval/decided"]')).toHaveCount(1);
      } else {
        // 通过生产 dual-write 追加新审批和持久事件，Web 用真实 SSE catch-up 接收。
        await createPendingApproval(store, 'r24_new_pending');
        await expect(page.locator('[data-event-type="approval/requested"]')).toHaveCount(3);
      }

      const gates = await readRpc<{ pendingDecisions: Array<{ id: string }> }>(
        page, server.url, fixture.sessionToken, 'gate.list', { runId: 'run_1' },
      );
      const expectedIds = change === 'decided'
        ? ['r24_kept_pending']
        : ['decision_1', 'r24_kept_pending', 'r24_new_pending'];
      expect(gates.pendingDecisions.map((decision) => decision.id).sort()).toEqual(expectedIds.sort());
      // 保留的审批在初始事件和数据库中一直 pending，不能靠 false→true 重挂查询碰巧刷新。
      await expect(card('r24_kept_pending')).toBeVisible();
      if (change === 'decided') {
        await expect(card('decision_1')).toHaveCount(0);
      } else {
        await expect(card('r24_new_pending')).toBeVisible();
      }
      await expect(approvals.locator('.approval-card')).toHaveCount(expectedIds.length);
    } finally {
      store.db.close();
    }
  });
}

const inFlightCases = [
  { title: '迟到成功', outcome: 'success', states: ['failed'], remount: false },
  { title: '迟到 500', outcome: '500', states: ['failed'], remount: false },
  {
    title: '多次 SSE 失效合并',
    outcome: 'success',
    states: ['awaiting-input', 'active', 'failed'],
    remount: false,
  },
  { title: '离开并重新挂载', outcome: 'success', states: ['failed'], remount: true },
] as const;

for (const scenario of inFlightCases) {
  test(`R24：列表查询在途时${scenario.title}，丢弃旧发布并自动取得新事实`, async ({
    page,
    server,
    fixture,
  }) => {
    const store = openObservationStore(fixture.projectRoot);
    const responses = await holdSessionListResponses(page);
    try {
      await observeWorkspaceReads(page);
      const session = await createListSession(store, fixture.projectRoot);
      await page.goto(server.url);
      const row = page.locator(`a.session-list-link[href="/sessions/${session.id}"]`);
      await expect(row.locator('.badge[title="active"]')).toBeVisible();
      await expect.poll(async () => (await workspaceReads(page)).connections.length).toBe(1);
      await settleBrowser(page);
      await expect(row.locator('.badge[title="active"]')).toBeVisible();
      await expect.poll(() => responses.stats.active).toBe(0);
      const requestBaseline = responses.stats.requests;
      let frames = (await workspaceReads(page)).connections[0].frames;
      const obsolete = responses.holdNext(scenario.outcome);
      const fresh = scenario.remount ? null : responses.holdNext();

      // idle 是真实数据库的中间事实，与已发布 active 区分。它被读入但一直扣住发送，
      // 因此即便 UI 将来保留刷新前数据，仍能检测这个未曾发布的旧快照是否闪现。
      await store.sessions.updateSessionStatus(session.id, 'idle');
      await page.getByRole('button', { name: '↻ 刷新', exact: true }).click();
      const captured = await obsolete.captured;
      expect(captured.sessions.find((candidate) => candidate.id === session.id)?.status).toBe('idle');
      await expect.poll(async () => (await workspaceReads(page)).connections[0].frames).toBe(++frames);
      await settleBrowser(page);
      await observeListPublications(page, session.id);

      for (const status of scenario.states) {
        await store.sessions.updateSessionStatus(session.id, status);
        // 每次都确认生产 reader 收到一个真实新帧，再进入下一次变更，避免服务端
        // 一次 signature catch-up 合并写入而使“多次失效”测试只有一次失效。
        await expect.poll(async () => (await workspaceReads(page)).connections[0].frames).toBe(++frames);
        await settleBrowser(page);
        expect(responses.stats.requests).toBe(requestBaseline + 1);
      }

      if (scenario.remount) {
        // 使用真实 SPA 导航保留同一 cache；整页 reload 会丢失需要验证的旧请求所有权。
        await page.getByRole('link', { name: '高级 Advanced', exact: true }).click();
        await expect(page).toHaveURL(/\/advanced$/u);
        await expect.poll(async () => (await workspaceReads(page)).connections[0].ended).toBe(true);
        obsolete.release();
        await obsolete.completed;
        await settleBrowser(page);
        expect(responses.stats.requests).toBe(requestBaseline + 1);
        await page.getByRole('link', { name: '受控交付', exact: true }).click();
      } else {
        obsolete.release();
        const current = await fresh!.captured;
        expect(current.sessions.find((candidate) => candidate.id === session.id)?.status).toBe('failed');
        await settleBrowser(page);
        // 后续真实查询也先扣住，以观察旧成功／错误有没有短暂发布。
        await expect(row.locator('.badge[title="idle"]')).toHaveCount(0);
        await expect(page.getByText(STALE_LIST_ERROR, { exact: true })).toHaveCount(0);
        expect(responses.stats.requests).toBe(requestBaseline + 2);
        fresh!.release();
        await fresh!.completed;
      }

      await expect(row.locator('.session-list-action-failed')).toHaveText('需处理');
      await settleBrowser(page);
      const published = await listPublications(page);
      expect(published.statuses).toContain('failed');
      expect(published.statuses).not.toContain('idle');
      expect(published.staleError).toBe(false);
      expect(responses.stats.maxActive).toBe(1);
      if (!scenario.remount) {
        // 同一在途请求中的失效只能合并成一次后续读取；没有点击重试或手动刷新。
        expect(responses.stats.requests).toBe(requestBaseline + 2);
      }
    } finally {
      await responses.close();
      store.db.close();
    }
  });
}
