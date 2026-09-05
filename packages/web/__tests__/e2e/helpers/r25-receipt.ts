import { renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { openTekonDatabase } from '@tekon/core';
import type { APIResponse, Locator, Page, Route, TestInfo } from '@playwright/test';

import type { RpcProcedureMap } from '../../../src/shared/rpc-contract.js';
import { test as sharedTest, expect } from '../shared-fixture.js';

export type Entry = 'simple' | 'advanced';
export type Receipt = RpcProcedureMap['project.run']['output'];
type RunInput = RpcProcedureMap['project.run']['input'];
type Lookup = RpcProcedureMap['project.admission']['output'];
type StorageMethod = 'getItem' | 'setItem' | 'removeItem';
const TABLES = ['run_admissions', 'workflow_instances', 'sessions'] as const;
export const LOCAL_WARNING =
  '请求已受理，但浏览器请求记录更新或页面跳转未完成。请通过下方入口观察原运行，不要重复新建。';

declare global {
  interface Window {
    __r25Storage?: { hits: number; restore(): void };
  }
}

/** 只对当前文档、当前 admission key 的一次本地 I/O 注入；认证存储继续使用原方法。 */
export async function failStorageOnce(page: Page, method: StorageMethod) {
  await page.evaluate((selected) => {
    window.__r25Storage?.restore();
    const target = window.sessionStorage;
    const key = Object.keys(target).find((value) => value.startsWith('tekon.run-admissions.v1.'));
    if (!key) throw new Error('R25 夹具应先由真实页面保存请求账本');
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    const state = {
      hits: 0,
      restore() {
        Storage.prototype.getItem = get;
        Storage.prototype.setItem = set;
        Storage.prototype.removeItem = remove;
      },
    };
    const fail = (receiver: Storage, candidate: string, operation: string) => {
      if (receiver === target && candidate === key && operation === selected && state.hits === 0) {
        state.hits++;
        throw new DOMException('R25_PRIVATE_STORAGE_SENTINEL', 'QuotaExceededError');
      }
    };
    Storage.prototype.getItem = function (candidate) {
      fail(this, candidate, 'getItem');
      return get.call(this, candidate);
    };
    Storage.prototype.setItem = function (candidate, value) {
      fail(this, candidate, 'setItem');
      return set.call(this, candidate, value);
    };
    Storage.prototype.removeItem = function (candidate) {
      fail(this, candidate, 'removeItem');
      return remove.call(this, candidate);
    };
    window.__r25Storage = state;
  }, method);
}

export async function expectStorageFailure(page: Page) {
  await expect.poll(() => page.evaluate(() => window.__r25Storage?.hits)).toBe(1);
  await page.evaluate(() => window.__r25Storage?.restore());
}

export function controls(page: Page, entry: Entry) {
  return {
    demand: page.getByLabel(entry === 'simple' ? '新建受控交付任务' : '需求描述', { exact: true }),
    submit: page.getByRole('button', {
      name: entry === 'simple' ? /启动受控交付|正在创建交付/u : /发起运行|启动中/u,
    }),
  };
}

export async function openEntry(page: Page, url: string, entry: Entry) {
  await page.goto(entry === 'simple' ? url : `${url}/advanced/runs`);
  // shared beforeEach 已预热首页；goto 同一路径加 #token 可能只导航 hash，
  // 不会重新读取计划。默认入口需在本夹具拦截安装后开启新文档，排除旧 codex 预览缓存。
  if (entry === 'simple') await page.reload();
  if (entry === 'advanced') {
    await page.getByRole('button', { name: '✦ 新建运行' }).click();
    await page.getByLabel('执行代理', { exact: true }).selectOption('mock');
    await expect(page.getByLabel('执行代理', { exact: true })).toHaveValue('mock');
  }
  await expect(controls(page, entry).demand).toBeVisible();
}

/** code 精确匹配原 requestId，避免把共存的其他未知请求当成本行降级。 */
export function receiptRow(page: Page, requestId: string) {
  const identity = page.locator('code').filter({ hasText: new RegExp(`^${requestId}$`, 'u') });
  return page.getByTestId('admission-notice').locator(':scope > div').filter({ has: identity });
}

export async function expectKnown(page: Page, receipt: Receipt, state = receipt.admissionState) {
  const row = receiptRow(page, receipt.requestId);
  await expect(row).toHaveCount(1);
  await expect(row.locator('strong')).toHaveText(
    state === 'accepted' ? '已受理' : '已受理，等待目录恢复',
  );
  await expect(row).not.toContainText('受理状态待确认');
  await expect(row.getByRole('link', { name: '观察原会话', exact: true }))
    .toHaveAttribute('href', `/sessions/${receipt.sessionId}`);
  if (state === 'recovery-required') {
    await expect(row).toContainText('任务尚未执行');
    await expect(row.getByRole('button', { name: /查询受理结果|正在查询…/u })).toBeVisible();
  }
  return row;
}

export async function expectLocalWarning(page: Page) {
  await expect(page.getByTestId('admission-notice').getByRole('alert')).toHaveText(LOCAL_WARNING);
  await expect(page.getByTestId('admission-notice')).not.toContainText('R25_PRIVATE_');
}

export async function observeOriginal(page: Page, receipt: Receipt) {
  const observed = page.waitForResponse((response) => {
    if (!response.url().endsWith('/api/rpc')) return false;
    const body = response.request().postDataJSON();
    return body.path === 'session.get' && body.input.sessionId === receipt.sessionId;
  });
  await receiptRow(page, receipt.requestId).getByRole('link', { name: '观察原会话', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${receipt.sessionId}$`, 'u'));
  const body = await (await observed).json();
  expect(body.error).toBeUndefined();
  expect(body.result.session).toMatchObject({ id: receipt.sessionId, runId: receipt.run.id });
  await expect(page.locator('.session-detail .page-title')).toBeVisible();
  // 开场 user/message 从真实 SQLite 经 HTTP/SSE 进入已导航的 Session 页面。
  await expect(page.locator('[data-event-type="user/message"]')).toBeVisible();
}

export class ReceiptHarness {
  readonly db: ReturnType<typeof openTekonDatabase>;
  readonly requests: RunInput[] = [];
  readonly replies: Receipt[] = [];
  readonly lookups: Lookup[] = [];
  longRequestIds = false;
  onRun?: (route: Route, input: RunInput, index: number) => Promise<void>;
  onLookup?: (route: Route, requestId: string) => Promise<void>;
  private readonly baseline: Record<string, number>;
  private readonly initialJobs: number;
  private readonly previewDigests = new Set<string>();
  private readonly preparedIntents: Array<Record<string, unknown>> = [];
  private restoreDirectory?: () => void;
  private readonly releases: Array<() => void> = [];
  private intents = 0;

  constructor(readonly page: Page, readonly projectRoot: string) {
    this.db = openTekonDatabase({ filename: join(projectRoot, '.tekon', 'tekon.sqlite') });
    this.baseline = this.counts();
    this.initialJobs = this.countInitialJobs();
  }

  async install() {
    await this.page.route('**/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.path === 'workflow.plan') {
        const response = await route.fetch({ postData: JSON.stringify({
          ...body, input: { ...body.input, agent: 'mock' },
        }) });
        const data = await response.json();
        expect(response.status()).toBe(200);
        expect(data.error).toBeUndefined();
        // RPC 预览白名单不返回 agent；Provider 由发送输入及受理后的持久快照证明。
        expect(data.result.digest).toMatch(/^[a-f0-9]{64}$/u);
        this.previewDigests.add(data.result.digest as string);
        return route.fulfill({ response });
      }
      if (body.path === 'project.run') {
        const input = this.mockRunInput(route);
        const { token: _token, requestId: _requestId, ...intent } = input;
        expect(this.preparedIntents).toContainEqual(intent);
        expect(this.previewDigests.has(input.planDigest!)).toBe(true);
        this.requests.push(input);
        if (this.onRun) return this.onRun(route, input, this.requests.length);
        const { response } = await this.fetchRun(route);
        return route.fulfill({ response });
      }
      if (body.path === 'project.admission') {
        if (this.onLookup) return this.onLookup(route, body.input.requestId as string);
        const { response } = await this.fetchLookup(route);
        return route.fulfill({ response });
      }
      if (body.path === 'project.admissionIntent' && body.input.run) {
        const run = { ...body.input.run, agent: 'mock' };
        expect(this.previewDigests.has(run.planDigest as string)).toBe(true);
        const response = await route.fetch({ postData: JSON.stringify({
          ...body, input: { ...body.input, run },
        }) });
        const data = await response.json();
        expect(response.status()).toBe(200);
        expect(data.error).toBeUndefined();
        this.preparedIntents.push(run);
        // requestId 是调用者可选标识；仅把服务端建议改成合法的长度边界值。
        if (this.longRequestIds) {
          data.result.requestId = `r25-request-${++this.intents}-`.padEnd(128, 'x');
          return route.fulfill({ response, json: data });
        }
        return route.fulfill({ response });
      }
      return route.continue();
    });
  }

  /**
   * 默认入口没有 Provider 选择器，因此仅在测试传输边界把 plan、intent 与 run
   * 一致改为 mock；真实服务端仍计算摘要/指纹、校验确认并写 SQLite。
   * 这些用例验证页面与受理边界，不声称默认 codex 或任何真实模型执行已验收。
   */
  private mockRunInput(route: Route): RunInput {
    return { ...route.request().postDataJSON().input, agent: 'mock' } as RunInput;
  }

  async fetchRun(route: Route): Promise<{ response: APIResponse; receipt: Receipt }> {
    const input = this.mockRunInput(route);
    const response = await route.fetch({ postData: JSON.stringify({ path: 'project.run', input }) });
    const body = await response.json();
    expect(response.status()).toBe(200);
    expect(body.error).toBeUndefined();
    const receipt = body.result as Receipt;
    expect(receipt.requestId).toBe(route.request().postDataJSON().input.requestId);
    expect(receipt.sessionId).toBeTruthy();
    expect(receipt.jobId).toBeTruthy();
    this.expectMockProvider(receipt, input.planDigest!);
    this.replies.push(receipt);
    return { response, receipt };
  }

  async fetchLookup(route: Route): Promise<{ response: APIResponse; result: Lookup }> {
    const response = await route.fetch();
    const body = await response.json();
    expect(response.status()).toBe(200);
    expect(body.error).toBeUndefined();
    const result = body.result as Lookup;
    this.lookups.push(result);
    return { response, result };
  }

  hold() {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    this.releases.push(release);
    return { wait, release };
  }

  blockDirectory() {
    if (this.restoreDirectory) throw new Error('R25 目录故障不可重复安装');
    const runRoot = join(this.projectRoot, '.tekon', 'runs');
    const backup = join(this.projectRoot, '.tekon', 'runs-r25-backup');
    renameSync(runRoot, backup);
    let obstructionCreated = false;
    this.restoreDirectory = () => {
      if (obstructionCreated) unlinkSync(runRoot);
      renameSync(backup, runRoot);
      this.restoreDirectory = undefined;
    };
    try {
      writeFileSync(runRoot, 'R25 临时夹具：普通文件不能充当运行目录');
      obstructionCreated = true;
    } catch (error) {
      this.restoreDirectory();
      throw error;
    }
  }

  restoreFiles() { this.restoreDirectory?.(); }

  private counts() {
    return Object.fromEntries(TABLES.map((table) => [table,
      (this.db.prepare(`select count(*) as total from ${table}`).get() as { total: number }).total,
    ]));
  }

  private countInitialJobs() {
    return (this.db.prepare("select count(*) as total from jobs where kind in ('workflow-run', 'goal-run')")
      .get() as { total: number }).total;
  }

  private expectMockProvider(receipt: Receipt, expectedDigest?: string) {
    expect(receipt.run.provider).toBe('mock');
    const provider = this.db.prepare('select provider, config_summary from run_provider_configs where run_id=?')
      .get(receipt.run.id) as { provider: string; config_summary: string };
    expect(provider).toBeTruthy();
    expect(provider.provider).toBe('mock');
    expect(JSON.parse(provider.config_summary)).toEqual({ provider: 'mock' });
    const binding = this.db.prepare('select plan_snapshot, plan_digest from workflow_instances where id=?')
      .get(receipt.run.id) as { plan_snapshot: string; plan_digest: string };
    expect(JSON.parse(binding.plan_snapshot).agent).toBe('mock');
    expect(this.previewDigests.has(binding.plan_digest)).toBe(true);
    if (expectedDigest) expect(binding.plan_digest).toBe(expectedDigest);
  }

  expectOneAdmission(receipt: Receipt) {
    expect(this.counts()).toEqual(Object.fromEntries(TABLES.map((table) => [table, this.baseline[table]! + 1])));
    expect(this.db.prepare('select request_id, run_id, session_id, job_id from run_admissions where request_id=?')
      .get(receipt.requestId)).toEqual({
      request_id: receipt.requestId, run_id: receipt.run.id, session_id: receipt.sessionId, job_id: receipt.jobId,
    });
    // gate/result 可以异步派生 readiness-evaluate；它不是另一条受理初始 Job。
    // 对全部初始 Job 检查总增量，再严格核对本会话仅有这一个执行 Job，仍能发现换 ID 重建。
    expect(this.countInitialJobs()).toBe(this.initialJobs + 1);
    expect(this.db.prepare("select id, session_id, kind from jobs where session_id=? and kind in ('workflow-run', 'goal-run', 'workflow-resume')")
      .all(receipt.sessionId)).toEqual([{ id: receipt.jobId, session_id: receipt.sessionId, kind: 'workflow-run' }]);
    this.expectMockProvider(receipt);
  }

  expectNotExecuted(receipt: Receipt) {
    expect(this.db.prepare('select count(*) as total from role_runs where run_id=?').get(receipt.run.id))
      .toEqual({ total: 0 });
  }

  private screenshotState(receipt: Receipt) {
    const jobs = this.db.prepare('select id, kind, status from jobs where session_id=? order by id')
      .all(receipt.sessionId) as Array<{ id: string; kind: string; status: string }>;
    const initial = jobs.find((job) => job.id === receipt.jobId);
    const admission = this.db.prepare('select files_state from run_admissions where request_id=?')
      .get(receipt.requestId) as { files_state: string } | undefined;
    const session = this.db.prepare('select status from sessions where id=?')
      .get(receipt.sessionId) as { status: string } | undefined;
    const run = this.db.prepare('select status from workflow_instances where id=?')
      .get(receipt.run.id) as { status: string } | undefined;
    const terminal = new Set(['done', 'failed', 'cancelled', 'interrupted']);
    const events = this.db.prepare(`select
      coalesce(max(case when type in ('gate/result', 'approval/decided') then seq end), 0) as trigger_seq,
      coalesce(max(case when type = 'readiness/evaluated' then seq end), 0) as evaluated_seq
      from session_events where session_id=?`).get(receipt.sessionId) as { trigger_seq: number; evaluated_seq: number };
    const notExecuted = (this.db.prepare('select count(*) as total from role_runs where run_id=?')
      .get(receipt.run.id) as { total: number }).total === 0;
    const stable = receipt.admissionState === 'recovery-required'
      // 目录阻断时初始 Job 必须保持 queued；它是稳定的未执行状态，不能强迫其进入终态。
      ? admission?.files_state === 'recovery_required' && initial?.status === 'queued' && notExecuted &&
        jobs.every((job) => job.id === receipt.jobId || terminal.has(job.status))
      : admission?.files_state === 'ready' && initial !== undefined && terminal.has(initial.status) &&
        jobs.every((job) => terminal.has(job.status)) &&
        // 必须看见真实 readiness 产物；旧 Job 的迟到产物仍需下方稳定窗口排除。
        (events.trigger_seq === 0 || events.evaluated_seq > events.trigger_seq) &&
        session !== undefined && session.status !== 'active' && run !== undefined && run.status !== 'running';
    return { requestId: receipt.requestId, runId: receipt.run.id, sessionId: receipt.sessionId,
      stable: stable && session !== undefined && run !== undefined,
      jobs, filesState: admission?.files_state, sessionStatus: session?.status, runStatus: run?.status, ...events };
  }

  expectScreenshotState(receipt: Receipt) {
    const snapshot = this.screenshotState(receipt);
    expect(snapshot).toMatchObject({ stable: true });
    return snapshot;
  }

  async refreshForScreenshot(entry: Entry, receipt: Receipt, info: TestInfo) {
    const stabilityWindowMs = 750;
    let candidateKey: string | null = null;
    let candidateSince = 0;
    let observedStableMs = 0;
    await expect.poll(() => {
      const state = this.screenshotState(receipt);
      const key = JSON.stringify(state);
      const now = performance.now();
      if (!state.stable) {
        candidateKey = null;
        observedStableMs = 0;
      } else {
        if (candidateKey !== key) {
          candidateKey = key;
          candidateSince = now;
        }
        observedStableMs = now - candidateSince;
      }
      // 旧 readiness Job 可能晚于最后 gate 才发布产物。完整候选快照须连续稳定
      // 超过服务端 500ms debounce；新 Job/事件/状态一旦变化，重新开始观察。
      return { ...state, windowComplete: state.stable && observedStableMs >= stabilityWindowMs };
    }, {
      message: '采图前等待真实 Job、事件序号和会话/运行状态连续稳定至少 750ms；目录阻断保持未执行',
      intervals: [100],
      timeout: 20_000,
    }).toMatchObject({ stable: true, windowComplete: true });
    const snapshot = this.expectScreenshotState(receipt);
    const path = entry === 'simple' ? 'session.list' : 'project.detail';
    // 等待点击之后真正发出的读取，不能把点击前的旧响应或只检查 DOM 当作刷新证据。
    const nextRequest = this.page.waitForRequest((request) => request.url().endsWith('/api/rpc') &&
      request.postDataJSON().path === path);
    await this.page.locator('.page-header').getByRole('button', { name: '↻ 刷新', exact: true }).click();
    const response = await (await nextRequest).response();
    expect(response).not.toBeNull();
    expect(response!.status()).toBe(200);
    const body = await response!.json();
    expect(body.error).toBeUndefined();
    let listItem: Locator;
    if (entry === 'simple') {
      const session = (body.result.sessions as Array<{ id: string; runId: string; status: string }>)
        .find((value) => value.id === receipt.sessionId);
      expect(session).toMatchObject({ id: receipt.sessionId, runId: receipt.run.id, status: snapshot.sessionStatus });
      const item = this.page.locator('.session-list-item').filter({
        has: this.page.locator(`a[href="/sessions/${receipt.sessionId}"]`),
      });
      await expect(item).toBeVisible();
      await expect(item).toHaveAttribute('title', `关联运行 ${receipt.run.id}`);
      if (receipt.admissionState === 'recovery-required')
        await expect(item.locator('.badge')).toHaveText('已受理，等待目录恢复');
      else await expect(item.locator('.badge')).toHaveAttribute('title', snapshot.sessionStatus!);
      listItem = item;
    } else {
      const run = (body.result.runs as Array<{ id: string; status: string }>).find((value) => value.id === receipt.run.id);
      expect(run).toMatchObject({ id: receipt.run.id, status: snapshot.runStatus });
      const id = receipt.run.id;
      const displayedId = id.length <= 16 ? id : `${id.slice(0, 7)}…${id.slice(-4)}`;
      const row = this.page.locator('.table-wrap tbody tr').filter({ has: this.page.getByText(displayedId, { exact: true }) });
      await expect(row).toBeVisible();
      await expect(row.locator('.badge').first()).toHaveText(
        receipt.admissionState === 'recovery-required' ? '已受理，等待目录恢复' : snapshot.runStatus!,
      );
      listItem = row;
    }
    await expect(this.page.locator('#main-content').getByText(/^(加载中\.\.\.|加载运行列表\.\.\.)$/u)).toHaveCount(0);
    await expect(this.page.locator('#main-content [style*="spin"]')).toHaveCount(0);
    const finalState = this.expectScreenshotState(receipt);
    expect(finalState).toEqual(snapshot);
    await info.attach('receipt-list-stable-state', {
      body: JSON.stringify({ ...finalState, stabilityWindowMs, observedStableMs }, null, 2), contentType: 'application/json',
    });
    return listItem;
  }

  async dispose() {
    for (const release of this.releases) release();
    try {
      await this.page.unrouteAll({ behavior: 'wait' });
      if (!this.page.isClosed()) await this.page.evaluate(() => window.__r25Storage?.restore());
    } finally {
      try { this.restoreFiles(); } finally { this.db.close(); }
    }
  }
}

export const test = sharedTest.extend<{ receipts: ReceiptHarness }>({
  receipts: async ({ page, fixture }, use) => {
    const receipts = new ReceiptHarness(page, fixture.projectRoot);
    try {
      await receipts.install();
      await use(receipts);
    } finally {
      await receipts.dispose();
    }
  },
});
export { expect };

export async function auditReceiptNotice(page: Page, info: TestInfo, label: string) {
  const notice = page.getByTestId('admission-notice');
  await expect(notice).toBeVisible();
  await page.evaluate(async () => { await document.fonts.ready; });
  const geometry = await notice.evaluate((root) => {
    const visible = (element: Element) => {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return bounds.width > 0 && bounds.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const controls = [...root.querySelectorAll<HTMLElement>('button,a[href]')].filter(visible);
    const boxes = controls.map((element) => {
      const rect = element.getBoundingClientRect();
      return { label: element.textContent?.trim(), left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    });
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) overlaps.push(`${a.label}/${b.label}`);
    }
    const clipped: string[] = [];
    for (const element of controls) {
      const box = element.getBoundingClientRect();
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (getComputedStyle(ancestor).overflowX === 'visible') continue;
        const outer = ancestor.getBoundingClientRect();
        if (box.left < outer.left - 1 || box.right > outer.right + 1) clipped.push(element.textContent?.trim() ?? 'control');
      }
    }
    const textOutside: string[] = [];
    const textClipped: string[] = [];
    let fragments = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const text = walker.currentNode as Text;
      if (!text.data.trim() || !text.parentElement || !visible(text.parentElement)) continue;
      const range = document.createRange();
      range.selectNodeContents(text);
      for (const box of range.getClientRects()) {
        if (!box.width || !box.height) continue;
        fragments++;
        if (box.left < -1 || box.right > innerWidth + 1) textOutside.push(text.data.trim());
        for (let ancestor: HTMLElement | null = text.parentElement; ancestor; ancestor = ancestor.parentElement) {
          if (getComputedStyle(ancestor).overflowX === 'visible') continue;
          const outer = ancestor.getBoundingClientRect();
          if (box.left < outer.left - 1 || box.right > outer.right + 1) {
            textClipped.push(text.data.trim());
            break;
          }
        }
      }
    }
    return { viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
      boxes, outside: boxes.filter((box) => box.left < -1 || box.right > innerWidth + 1),
      overlaps, clipped, textOutside, textClipped, fragments };
  });
  await info.attach(`${label}-geometry`, { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
  expect(geometry.documentWidth).toBeLessThanOrEqual(geometry.viewport + 1);
  expect(geometry.fragments).toBeGreaterThan(0);
  expect(geometry.outside).toEqual([]);
  expect(geometry.overlaps).toEqual([]);
  expect(geometry.clipped).toEqual([]);
  expect(geometry.textOutside).toEqual([]);
  expect(geometry.textClipped).toEqual([]);
}

export async function reachByKeyboard(page: Page, from: Locator, target: Locator) {
  await from.focus();
  let reached = false;
  for (let index = 0; index < 70; index++) {
    await page.keyboard.press('Tab');
    if (await target.evaluate((element) => document.activeElement === element)) {
      reached = true;
      break;
    }
  }
  expect(reached, '关键观察/查询入口应通过顺序 Tab 到达').toBe(true);
  await expect(target).toBeFocused();
  await expect(target).toBeEnabled();
  await target.scrollIntoViewIfNeeded();
  const bounds = await target.boundingBox();
  expect(bounds).not.toBeNull();
  const viewport = page.viewportSize()!;
  expect(bounds!.x).toBeGreaterThanOrEqual(-1);
  expect(bounds!.y).toBeGreaterThanOrEqual(-1);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width + 1);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height + 1);
  await target.click({ trial: true });
}

export async function captureReceipt(page: Page, info: TestInfo, label: string) {
  await page.locator('#main-content').focus();
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const path = info.outputPath(`${label}.png`);
  await page.screenshot({ path, fullPage: true, animations: 'disabled', caret: 'hide' });
  await info.attach(label, { path, contentType: 'image/png' });
}
