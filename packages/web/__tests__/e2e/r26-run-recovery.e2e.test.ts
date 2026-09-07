import { join } from 'node:path';
import { createSessionEventStore, createWriteQueue, openTekonDatabase } from '@tekon/core';
import type { Page, Route } from '@playwright/test';
import { test, expect } from './shared-fixture.js';

// The HTTP faults below isolate browser semantics; Core owns process-exit proof.
async function recoveryFixture(page: Page) {
  const state = {
    status: 'running',
    legacyStatus: null as string | null,
    approved: false,
    cancelRecovery: null as null | { needsControlRetry: boolean; needsObservationRepair: boolean; jobId: string | null; exitStatus: 'confirmed' | 'unconfirmed' },
    resumeRecovery: null as null | { previousJobId: string | null; requiresConfirmation: boolean },
    requests: [] as Array<{ path: string; input: Record<string, unknown> }>,
    cancel: async (route: Route) => route.fulfill({ json: { result: { run: { id: 'run_1', status: state.status } } } }),
    approve: async (route: Route) => { state.approved = true; return route.fulfill({ json: { result: { decision: { id: 'decision_1' }, resumeOutcome: 'not-enqueued', resumeMessage: '旧执行代次发生变化，请重新核对。', recovery: { runStatus: state.status, cancelRecovery: state.cancelRecovery, resumeRecovery: state.resumeRecovery } } } }); },
    resume: async (route: Route) => route.fulfill({ json: { result: { run: { id: 'run_1', status: 'running' } } } }),
  };
  await page.route('**/api/rpc', async route => {
    const body = route.request().postDataJSON() as { path: string; input: Record<string, unknown> };
    if (body.path === 'project.cancel' || body.path === 'project.resume' || body.path === 'gate.approve') {
      state.requests.push(body);
      return body.path === 'project.cancel' ? state.cancel(route) : body.path === 'project.resume' ? state.resume(route) : state.approve(route);
    }
    if (body.path === 'gate.list' && state.approved) {
      const response = await route.fetch();
      const json = await response.json();
      json.result.pendingDecisions = [];
      return route.fulfill({ response, json });
    }
    if ((body.path === 'review.get' && body.input?.runId === 'run_1') || body.path === 'project.overview' || body.path === 'session.get' || body.path === 'project.detail') {
      const response = await route.fetch();
      const json = await response.json();
      const target = body.path === 'project.overview' ? json.result.latestRun : body.path === 'session.get' ? json.result.session : body.path === 'project.detail' ? json.result.runs.find((run: { id: string }) => run.id === 'run_1') : json.result;
      target.workflowStatus = state.legacyStatus ?? state.status;
      target.runStatus = state.status;
      if (body.path === 'project.overview') target.status = state.status;
      target.recovery = { runStatus: state.status, cancelRecovery: state.cancelRecovery, resumeRecovery: state.resumeRecovery };
      return route.fulfill({ response, json });
    }
    return route.continue();
  });
  return state;
}
async function auditGeometry(page: Page) {
  const bad = await page.locator('.run-controls, .run-controls button, .run-controls label, .flash-item').evaluateAll(elements => elements.flatMap(element => {
    const rect = element.getBoundingClientRect();
    return rect.width && (rect.left < -1 || rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1) ? [element.textContent] : [];
  }));
  expect(bad).toEqual([]);
  const recoveryLayout = await page.locator('.run-header').evaluateAll(headers => headers.every(header => {
    if (!header.querySelector('.run-recovery-notice, .run-recovery-confirmation')) return true;
    const identity = header.firstElementChild!.getBoundingClientRect();
    const controls = header.querySelector('.run-header-actions')!.getBoundingClientRect();
    return controls.top >= identity.bottom - 1;
  }));
  expect(recoveryLayout, '恢复说明独立成行，保留运行身份的可读宽度').toBe(true);
  if (page.viewportSize()!.width <= 390) {
    expect(await page.locator('.approval-meta').evaluateAll(grids => grids.every(grid => Array.from(grid.children).every(item => item.getBoundingClientRect().width >= grid.clientWidth - 1))), '窄屏审批命令使用完整列宽').toBe(true);
  }
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
}

for (const width of [320, 390, 768, 1440]) {
  test(`R26 ${width}px: two-step keyboard cancel, failed delivery, reload and same-run retry`, async ({ page, server }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await recoveryFixture(page);
    const longError = `取消控制暂不可用；请稍后重试。${'delivery-error-'.repeat(35)}`;
    state.cancel = async route => {
      state.status = 'cancelled';
      state.cancelRecovery = { needsControlRetry: true, needsObservationRepair: true, jobId: 'original-job', exitStatus: 'unconfirmed' };
      await route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: longError } } });
    };
    await page.goto(`${server.url}/advanced/runs/run_1`);
    const regions = page.locator('.flash-container [role]');
    await expect(regions).toHaveCount(2);
    await expect(regions.nth(0)).toBeEmpty();
    await expect(regions.nth(1)).toBeEmpty();
    const cancel = page.getByRole('button', { name: '请求取消运行' });
    await cancel.focus();
    await page.keyboard.press('Enter');
    expect(state.requests).toHaveLength(0);
    await expect(page.getByRole('button', { name: '确认取消运行' })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: '重试取消运行' })).toBeVisible();
    await expect(page.locator('.run-recovery-error')).toHaveText(longError);
    await expect(page.locator('.flash-container [role="alert"]')).toContainText(longError);
    await expect(page.locator('.flash-container [role] [role], .flash-container [role] [aria-live]')).toHaveCount(0);
    await auditGeometry(page);
    await page.screenshot({ path: info.outputPath(`r26-${width}-cancel-error.png`), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '关闭通知' }).click();
    await expect(page.locator('.run-recovery-error')).toHaveText(longError);
    await page.reload();
    await expect(page.getByRole('button', { name: '重试取消运行' })).toBeVisible();
    await expect(page.locator('.run-recovery-notice')).toContainText('退出未确认');
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    state.cancel = async route => {
      await waiting;
      state.cancelRecovery = { needsControlRetry: false, needsObservationRepair: false, jobId: 'original-job', exitStatus: 'confirmed' };
      await route.fulfill({ json: { result: { run: { id: 'run_1', status: 'cancelled' } } } });
    };
    const retry = page.getByRole('button', { name: '重试取消运行' });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect(retry).toBeDisabled();
    await page.keyboard.press('Enter');
    expect(state.requests).toHaveLength(2);
    release();
    await expect(retry).toHaveCount(0);
    await expect(page.locator('.run-recovery-notice')).toContainText('已确认 Tekon 受管理执行句柄退出');
    expect(state.requests.every(request => request.input.runId === 'run_1')).toBe(true);
    await auditGeometry(page);
  });

  test(`R26 ${width}px: explicit old-job recovery confirmation with keyboard`, async ({ page, server }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await recoveryFixture(page);
    state.status = 'interrupted';
    state.legacyStatus = 'running';
    state.resumeRecovery = { previousJobId: width === 320 ? null : `previous-job-${'long-id-'.repeat(12)}`, requiresConfirmation: true };
    await page.goto(`${server.url}/advanced/runs/run_1`);
    const resume = page.getByRole('button', { name: '恢复运行' });
    await expect(resume).toBeDisabled();
    const checkbox = page.getByRole('checkbox', { name: /我已检查并停止旧进程/ });
    await checkbox.focus();
    await page.keyboard.press('Space');
    await page.keyboard.press('Tab');
    await expect(resume).toBeFocused();
    await auditGeometry(page);
    await page.screenshot({ path: info.outputPath(`r26-${width}-resume-confirmation.png`), fullPage: true, animations: 'disabled' });
    await page.keyboard.press('Enter');
    await expect.poll(() => state.requests.length).toBe(1);
    expect(state.requests[0]).toMatchObject({ path: 'project.resume', input: { runId: 'run_1', confirmStopped: true, previousJobId: state.resumeRecovery.previousJobId } });
  });
}

for (const winner of ['passed', 'failed']) {
  test(`R26 cancellation race preserves ${winner}`, async ({ page, server }) => {
    const state = await recoveryFixture(page);
    state.cancel = async route => { state.status = winner; await route.fulfill({ json: { result: { run: { id: 'run_1', status: winner } } } }); };
    await page.goto(`${server.url}/advanced/runs/run_1`);
    await page.getByRole('button', { name: '请求取消运行' }).click();
    await page.getByRole('button', { name: '确认取消运行' }).click();
    await expect(page.locator('.flash-container [role="status"]')).toContainText('未改为取消');
    await expect(page.getByRole('button', { name: '重试取消运行' })).toHaveCount(0);
    await expect(page.locator('.run-recovery-notice')).toHaveCount(0);
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`R26 ${width}px: Session refresh preserves cancelled recovery and approval partial success stays explicit`, async ({ page, server, fixture }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const db = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
    let sessionId: string;
    try {
      const store = createSessionEventStore(db, createWriteQueue());
      const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
      sessionId = (await store.createSession({ workspaceId: workspace.id, runId: 'run_1', profile: 'human-web', title: 'R26 取消观察恢复' })).id;
    } finally { db.close(); }
    const state = await recoveryFixture(page);
    state.status = 'cancelled';
    state.cancelRecovery = { needsControlRetry: false, needsObservationRepair: true, jobId: null, exitStatus: 'unconfirmed' };
    await page.goto(`${server.url}/sessions/${sessionId}`);
    await expect(page.getByRole('button', { name: '重试取消运行' })).toBeVisible();
    await expect(page.locator('.session-detail .page-header')).toContainText('已取消');
    await page.reload();
    const retry = page.getByRole('button', { name: '重试取消运行' });
    await retry.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => state.requests.length).toBe(1);
    expect(state.requests[0]!.input.runId).toBe('run_1');
    await expect(page.locator('.run-recovery-notice')).toContainText('退出未确认');
    await auditGeometry(page);
    await page.screenshot({ path: info.outputPath(`r26-${width}-session-recovery.png`), fullPage: true, animations: 'disabled' });

    await page.goto(`${server.url}/advanced/runs`);
    const tableRetry = page.getByRole('button', { name: '重试取消运行' });
    await expect(tableRetry).toBeVisible();
    await tableRetry.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => state.requests.length).toBe(2);
    await expect(page).toHaveURL(/\/advanced\/runs$/);

    state.status = 'interrupted';
    state.cancelRecovery = null;
    state.resumeRecovery = { previousJobId: 'table-previous-job', requiresConfirmation: true };
    await page.reload();
    const tableConfirmation = page.getByRole('checkbox', { name: /我已检查并停止旧进程/ });
    await tableConfirmation.check();
    await expect(tableConfirmation).toBeChecked();
    await expect(page).toHaveURL(/\/advanced\/runs$/);
    await page.getByRole('button', { name: '恢复运行' }).click();
    await expect.poll(() => state.requests.length).toBe(3);
    expect(state.requests.at(-1)).toMatchObject({ path: 'project.resume', input: { runId: 'run_1', confirmStopped: true, previousJobId: 'table-previous-job' } });
    await expect(page).toHaveURL(/\/advanced\/runs$/);

    state.resumeRecovery = { previousJobId: null, requiresConfirmation: true };
    await page.goto(`${server.url}/advanced/approvals`);
    const approve = page.getByRole('button', { name: '✓ 批准' });
    await expect(approve).toBeDisabled();
    await expect(page.getByRole('button', { name: '✗ 拒绝' })).toBeEnabled();
    await page.getByRole('checkbox', { name: /我已检查并停止旧进程/ }).check();
    await approve.click();
    await page.getByRole('button', { name: '确认批准?' }).click();
    await expect(page.locator('.flash-container [role="status"]')).toContainText('审批已记录，运行尚未恢复');
    await expect(page.locator('#main-content .run-recovery-notice')).toContainText('旧执行代次发生变化');
    await expect(page.locator('.approval-card')).toHaveCount(0);
    expect(state.requests.at(-1)).toMatchObject({ path: 'gate.approve', input: { confirmStopped: true, previousJobId: null } });
    await page.evaluate(() => window.scrollTo(0, 0));
    await auditGeometry(page);
    await page.screenshot({ path: info.outputPath(`r26-${width}-approval-partial.png`), fullPage: true, animations: 'disabled' });
  });
}

test('R26 narrow approval metadata keeps commands readable', async ({ page, server }, info) => {
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`${server.url}/advanced/approvals`);
    const meta = page.locator('.approval-meta');
    await expect(meta).toBeVisible();
    const widths = await meta.evaluate(grid => ({ width: grid.clientWidth, items: Array.from(grid.children).map(item => item.getBoundingClientRect().width) }));
    await info.attach(`approval-${width}-geometry`, { body: JSON.stringify(widths), contentType: 'application/json' });
    expect(widths.items.every(width => width >= widths.width - 1), JSON.stringify(widths)).toBe(true);
    const escaped = await page.locator('.approval-summary-section .flex.gap-2 > span:last-child').evaluateAll(cells => cells.flatMap(cell => {
      const rect = cell.getBoundingClientRect();
      const row = cell.parentElement!.getBoundingClientRect();
      return rect.right > row.right + 1 || cell.scrollWidth > cell.clientWidth + 1 ? [{ text: cell.textContent, right: rect.right, rowRight: row.right, width: cell.clientWidth, scrollWidth: cell.scrollWidth }] : [];
    }));
    expect(escaped).toEqual([]);
    await page.screenshot({ path: info.outputPath(`r26-${width}-approval-layout.png`), fullPage: true, animations: 'disabled' });
  }
});

test('R26 desktop Session approval metadata uses the rail width while the approval page keeps three columns', async ({ page, server, fixture }, info) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  const db = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
  let sessionId: string;
  try {
    const store = createSessionEventStore(db, createWriteQueue());
    const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
    sessionId = (await store.createSession({ workspaceId: workspace.id, runId: 'run_1', profile: 'human-web', title: 'R26 侧栏审批命令可读性' })).id;
    await store.updateSessionStatus(sessionId, 'awaiting-approval');
  } finally { db.close(); }
  await page.goto(`${server.url}/sessions/${sessionId}`);
  const railMeta = page.getByTestId('session-approvals').locator('.approval-meta');
  await expect(railMeta).toBeVisible();
  await expect(railMeta.locator('.approval-meta-value').first()).toHaveText('tekon run --template standard-delivery --agent codex');
  const railGeometry = await railMeta.evaluate(grid => ({ width: grid.clientWidth, items: Array.from(grid.children).map(item => ({ width: item.getBoundingClientRect().width, top: item.getBoundingClientRect().top })) }));
  await info.attach('desktop-session-meta-geometry', { body: JSON.stringify(railGeometry), contentType: 'application/json' });
  expect(railGeometry.items.every(item => item.width >= railGeometry.width - 1), JSON.stringify(railGeometry)).toBe(true);
  expect(railGeometry.items[1]!.top).toBeGreaterThan(railGeometry.items[0]!.top);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: info.outputPath('r26-desktop-session-approval-layout.png'), animations: 'disabled' });

  await page.goto(`${server.url}/advanced/approvals`);
  const pageMeta = page.locator('.approval-meta');
  await expect(pageMeta).toBeVisible();
  const pageGeometry = await pageMeta.evaluate(grid => ({ width: grid.clientWidth, items: Array.from(grid.children).map(item => ({ width: item.getBoundingClientRect().width, top: item.getBoundingClientRect().top })) }));
  expect(pageGeometry.items).toHaveLength(3);
  expect(pageGeometry.items.every(item => item.width < pageGeometry.width / 2 && Math.abs(item.top - pageGeometry.items[0]!.top) < 1), JSON.stringify(pageGeometry)).toBe(true);
  await page.screenshot({ path: info.outputPath('r26-desktop-approval-page-layout.png'), animations: 'disabled' });
});
