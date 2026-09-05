import { join } from 'node:path';
import {
  createSessionEventStore,
  createWriteQueue,
  openTekonDatabase,
} from '@tekon/core';
import { test, expect } from './shared-fixture.js';
import { credentialStatus } from './helpers/locators.js';

for (const firstSnapshot of ['delayed', '500'] as const) {
  test(`persisted opening SSE cannot enable controls before a ${firstSnapshot} snapshot then pending→ready`, async ({
    page,
    server,
    fixture,
  }) => {
    const db = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    const store = createSessionEventStore(db, createWriteQueue());
    let sessionId: string;
    try {
      const workspace = await store.getOrCreateDefaultWorkspace(
        fixture.projectRoot,
      );
      const session = await store.createSession({
        workspaceId: workspace.id,
        runId: 'run_1',
        profile: 'human-web',
        title: '事件先于受理快照',
      });
      sessionId = session.id;
      await store.updateSessionStatus(session.id, 'active');
      await store.appendEvent({
        sessionId,
        type: 'workflow/started',
        payload: { runId: 'run_1' },
      });
    } finally {
      db.close();
    }
    let releaseSnapshot!: () => void;
    const snapshotGate = new Promise<void>((resolve) => {
      releaseSnapshot = resolve;
    });
    let snapshotCount = 0;
    let filesState: 'pending' | 'ready' = 'pending';
    await page.route('**/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.path !== 'session.get') return route.continue();
      snapshotCount++;
      if (snapshotCount === 1) {
        await snapshotGate;
        if (firstSnapshot === '500')
          return route.fulfill({
            status: 500,
            json: {
              error: {
                code: 'INTERNAL_ERROR',
                message: 'admission snapshot unavailable',
              },
            },
          });
      }
      const response = await route.fetch();
      const result = await response.json();
      expect(result.result.session.id).toBe(sessionId);
      result.result.session = {
        ...result.result.session,
        status: 'active',
        admissionState:
          filesState === 'ready' ? 'accepted' : 'recovery-required',
        filesState,
      };
      return route.fulfill({ json: result });
    });
    await page.goto(`${server.url}/sessions/${sessionId}`);
    // The event is replayed by the real SSE endpoint from SQLite, not a hook mock.
    await expect(
      page.locator('[data-event-type="workflow/started"]'),
    ).toBeVisible();
    await expect(page.getByRole('button', { name: '暂停运行' })).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '请求取消运行' }),
    ).toHaveCount(0);
    releaseSnapshot();
    if (firstSnapshot === '500') {
      await expect(
        page.getByText('admission snapshot unavailable', { exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: '暂停运行' })).toHaveCount(
        0,
      );
      await page.getByRole('button', { name: '↻ 重试', exact: true }).click();
    }
    await expect(page.getByTestId('admission-readiness')).toContainText(
      '等待目录就绪',
    );
    await expect(page.getByRole('button', { name: '暂停运行' })).toHaveCount(0);
    filesState = 'ready';
    await expect(page.getByRole('button', { name: '暂停运行' })).toBeVisible({
      timeout: 8_000,
    });
    await expect(
      page.getByRole('button', { name: '请求取消运行' }),
    ).toBeVisible();
  });
}

for (const entry of ['simple', 'advanced'] as const) {
  test(`${entry}: losing an accepted response retries the same durable Run`, async ({
    page,
    server,
  }) => {
    const results: Array<{
      requestId: string;
      replayed: boolean;
      sessionId: string;
      run: { id: string };
    }> = [];
    const inputs: Array<{ requestId: string }> = [];
    await page.route('**/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.path !== 'project.run') return route.continue();
      inputs.push(body.input);
      const response = await route.fetch();
      const result = await response.json();
      expect(result.error).toBeUndefined();
      results.push(result.result);
      if (inputs.length === 1) return route.abort('connectionfailed');
      return route.fulfill({ response });
    });
    await page.goto(
      entry === 'simple' ? server.url : `${server.url}/advanced/runs`,
    );
    if (entry === 'advanced')
      await page.getByRole('button', { name: '✦ 新建运行' }).click();
    await page
      .getByLabel(entry === 'simple' ? '新建受控交付任务' : '需求描述', {
        exact: true,
      })
      .fill('受理后丢响应重试');
    const submit = page.getByRole('button', {
      name: entry === 'simple' ? '启动受控交付' : '▶ 发起运行',
    });
    await submit.click();
    await expect(page.getByTestId('admission-notice')).toContainText(
      '受理状态待确认',
    );
    await submit.click();
    await expect.poll(() => results.length).toBe(2);
    expect(inputs[1].requestId).toBe(inputs[0].requestId);
    expect(results[1].run.id).toBe(results[0].run.id);
    expect(results[1].sessionId).toBe(results[0].sessionId);
    expect(results[1].replayed).toBe(true);
  });

  test(`${entry}: unknown admission survives reload, not-found and same-content retry`, async ({
    page,
    server,
  }) => {
    const url = entry === 'simple' ? server.url : `${server.url}/advanced/runs`;
    const demandLabel = entry === 'simple' ? '新建受控交付任务' : '需求描述';
    const submitLabel = entry === 'simple' ? '启动受控交付' : '▶ 发起运行';
    const requests: Array<{
      requestId: string;
      demandText: string;
      token: string;
    }> = [];
    await page.route('**/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.path === 'project.run') {
        requests.push(body.input);
        return route.abort('connectionfailed');
      }
      if (body.path === 'project.admission')
        return route.fulfill({
          json: {
            result: { state: 'not-found', requestId: body.input.requestId },
          },
        });
      return route.continue();
    });
    await page.goto(url);
    if (entry === 'advanced')
      await page.getByRole('button', { name: '✦ 新建运行' }).click();
    await page.getByLabel(demandLabel, { exact: true }).fill('持久身份请求');
    await page.getByRole('button', { name: submitLabel }).click();
    await expect(page.getByTestId('admission-notice')).toContainText(
      '受理状态待确认',
    );
    expect(requests).toHaveLength(1);
    const id = requests[0].requestId;
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,128}$/);
    const ledger = await page.evaluate(() =>
      Object.keys(sessionStorage)
        .filter((key) => key.startsWith('tekon.run-admissions.'))
        .map((key) => sessionStorage.getItem(key))
        .join(''),
    );
    expect(ledger).toContain(id);
    expect(ledger).not.toContain(requests[0].token);
    expect(ledger).not.toContain('持久身份请求');
    await page.reload();
    if (entry === 'advanced')
      await page.getByRole('button', { name: '✦ 新建运行' }).click();
    await expect(page.getByLabel(demandLabel, { exact: true })).toHaveValue('');
    const notice = page.getByTestId('admission-notice');
    await expect(notice).toContainText(id);
    await notice.getByRole('button', { name: '查询受理结果' }).click();
    await expect(notice).toContainText('尚未查到记录不代表未受理');
    await page.getByLabel(demandLabel, { exact: true }).fill('持久身份请求');
    await page.getByRole('button', { name: submitLabel }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[1].requestId).toBe(id);
  });

  test(`${entry}: editing or token rotation while intent preparation waits cannot dispatch the captured payload`, async ({
    page,
    server,
  }) => {
    await page.goto(
      entry === 'simple' ? server.url : `${server.url}/advanced/runs`,
    );
    if (entry === 'advanced')
      await page.getByRole('button', { name: '✦ 新建运行' }).click();
    const demand = page.getByLabel(
      entry === 'simple' ? '新建受控交付任务' : '需求描述',
      { exact: true },
    );
    const submit = page.getByRole('button', {
      name: entry === 'simple' ? '启动受控交付' : '▶ 发起运行',
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let intentCount = 0;
    let runs = 0;
    let fulfilled!: () => void;
    const intentFulfilled = new Promise<void>((resolve) => {
      fulfilled = resolve;
    });
    await page.route('**/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.path === 'project.admissionIntent' && body.input.run) {
        intentCount++;
        const response = await route.fetch();
        await gate;
        await route.fulfill({ response });
        fulfilled();
        return;
      }
      if (body.path === 'project.run') runs++;
      return route.continue();
    });
    await demand.fill('不能发送的旧需求');
    await submit.click();
    await expect.poll(() => intentCount).toBe(1);
    await demand.fill('保留的新需求');
    await credentialStatus(page).click();
    await page.getByRole('button', { name: '清除凭据' }).click();
    await page.keyboard.press('Escape');
    release();
    await intentFulfilled;
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    expect(runs).toBe(0);
    await expect(demand).toHaveValue('保留的新需求');
  });

  test(`${entry}: expired plans require explicit refresh and another submit`, async ({
    page,
    server,
  }) => {
    await page.goto(
      entry === 'simple' ? server.url : `${server.url}/advanced/runs`,
    );
    if (entry === 'advanced')
      await page.getByRole('button', { name: '✦ 新建运行' }).click();
    let runs = 0;
    let plans = 0;
    await page.route('**/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.path === 'project.run') {
        runs++;
        return route.fulfill({
          status: 400,
          json: {
            error: {
              code: 'BAD_REQUEST',
              message: 'PLAN_DIGEST_MISMATCH: changed',
            },
          },
        });
      }
      if (body.path === 'workflow.plan') plans++;
      return route.continue();
    });
    await page
      .getByLabel(entry === 'simple' ? '新建受控交付任务' : '需求描述', {
        exact: true,
      })
      .fill('过期计划验证');
    const submit = page.getByRole('button', {
      name: entry === 'simple' ? '启动受控交付' : '▶ 发起运行',
    });
    await submit.click();
    await expect(page.getByTestId('admission-notice')).toContainText(
      '计划已变化，请刷新预览后重试',
    );
    await expect(submit).toBeDisabled();
    await page.getByRole('button', { name: '刷新执行计划' }).click();
    await expect(submit).toBeEnabled();
    expect(plans).toBe(1);
    expect(runs).toBe(1);
    await submit.click();
    await expect.poll(() => runs).toBe(2);
  });
}

test('sessionStorage write failure prevents dispatch instead of falling back to memory', async ({
  page,
  server,
}) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key.startsWith('tekon.run-admissions.'))
        throw new DOMException('quota', 'QuotaExceededError');
      original.call(this, key, value);
    };
  });
  let runs = 0;
  await page.route('**/api/rpc', async (route) => {
    if (route.request().postDataJSON().path === 'project.run') runs++;
    return route.continue();
  });
  await page.goto(`${server.url}/?storage-failure=1`);
  await page.getByLabel('新建受控交付任务').fill('不可丢失的请求身份');
  await page.getByRole('button', { name: '启动受控交付' }).click();
  await expect(page.getByTestId('admission-notice')).toContainText(
    '浏览器会话存储不可用',
  );
  expect(runs).toBe(0);
});

test('recovery-required sessions show their unready state in list and detail', async ({
  page,
  server,
}) => {
  const session = {
    id: 'session-unready',
    workspaceId: 'workspace',
    runId: 'run-unready',
    title: '需要恢复的交付',
    status: 'active',
    profile: 'human-web',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
    needsAction: false,
    actionKind: null,
    admissionState: 'recovery-required',
    filesState: 'recovery_required',
  };
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON();
    if (body.path === 'session.list')
      return route.fulfill({
        json: { result: { workspaceId: 'workspace', sessions: [session] } },
      });
    if (body.path === 'session.get')
      return route.fulfill({ json: { result: { session } } });
    if (body.path === 'session.events')
      return route.fulfill({
        json: { result: { events: [], hasMore: false, latestSeq: 0 } },
      });
    return route.continue();
  });
  await page.goto(`${server.url}/?unready=1`);
  const row = page.getByRole('link', { name: /需要恢复的交付/ });
  await expect(row).toContainText('创建失败需恢复');
  await expect(row).not.toContainText('active');
  await row.click();
  await expect(page.getByTestId('admission-readiness')).toContainText(
    '任务尚未执行',
  );
  await expect(page.getByRole('button', { name: /暂停|恢复运行/ })).toHaveCount(
    0,
  );
});
