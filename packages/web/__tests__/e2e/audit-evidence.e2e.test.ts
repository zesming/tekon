import { test, expect } from './shared-fixture.js';

for (const evidence of [
  { label: 'review-report artifact_1', path: 'artifacts?artifact=artifact_1', id: 'artifact-artifact_1', content: 'Review report body for dashboard.' },
  { label: 'human gate_1', path: 'gates?gate=gate_1', id: 'gate-log-gate_1', content: 'human approval is required' },
  { label: 'PR body', path: 'delivery?section=pr-body', id: 'pr-body', content: '# Add dashboard' },
  { label: 'PR package', path: 'delivery?section=pr-package', id: 'pr-package', content: '# PR Preparation' },
  { label: 'Delivery diff', path: 'delivery?section=diff', id: 'delivery-diff', content: '0 files' },
]) {
  test(`evidence ${evidence.label} opens and focuses its real content`, async ({ page, server }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(`${server.url}/advanced/runs/run_1`);
    const link = page.locator('.link-strip a').filter({ hasText: evidence.label }).first();
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(`${server.url}/advanced/runs/run_1/${evidence.path}`);
    const target = page.locator(`[id="${evidence.id}"]`);
    await expect(target).toBeFocused();
    await expect(target).toBeInViewport();
    const content = evidence.id.startsWith('artifact-') ? target.locator('..') : target;
    await expect(content).toContainText(evidence.content);
    expect(await content.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await page.reload();
    await expect(target).toBeFocused();
    await expect(content).toContainText(evidence.content);
  });
}

for (const target of [
  { path: 'artifacts?artifact=missing', message: '未找到该产物' },
  { path: 'gates?gate=missing', message: '未找到该门禁' },
  { path: 'delivery?section=missing', message: '未找到该交付章节' },
]) {
  test(`missing evidence ${target.path} gives visible feedback`, async ({ page, server }) => {
    await page.goto(`${server.url}/advanced/runs/run_1/${target.path}`);
    await expect(page.getByRole('status').filter({ hasText: target.message })).toBeVisible();
  });
}

for (const scenario of [
  { kind: 'artifact', state: 'missing', path: 'artifacts?artifact=artifact_1', message: '产物文件不存在' },
  { kind: 'gate', state: 'missing', path: 'gates?gate=gate_1', message: '门禁日志文件不存在' },
  { kind: 'gate', state: 'none', path: 'gates?gate=gate_1', message: '该门禁没有输出日志' },
  { kind: 'artifact', state: 'error', path: 'artifacts?artifact=artifact_1', message: '证据读取失败，请重试' },
  { kind: 'gate', state: 'error', path: 'gates?gate=gate_1', message: '证据读取失败，请重试' },
]) {
  test(`${scenario.kind} preview ${scenario.state} is explicit`, async ({ page, server }) => {
    await page.route('**/api/rpc', async route => {
      if (route.request().postDataJSON().path !== 'review.get') return route.continue();
      if (scenario.state === 'error') return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: scenario.message } } });
      const response = await route.fetch();
      const json = await response.json();
      if (scenario.kind === 'artifact') json.result.artifacts[0].content.exists = false;
      else if (scenario.state === 'none') json.result.gates[0].output = null;
      else json.result.gates[0].output.exists = false;
      return route.fulfill({ response, json });
    });
    await page.goto(`${server.url}/advanced/runs/run_1/${scenario.path}`);
    await expect(page.getByText(scenario.message, { exact: true })).toBeVisible();
    await expect(page.locator('.preview-block pre')).toHaveCount(0);
  });
}

test('artifact target hidden by filters can be revealed', async ({ page, server }) => {
  await page.goto(`${server.url}/advanced/runs/run_1/artifacts?artifact=artifact_1&node=missing`);
  await expect(page.getByRole('status').filter({ hasText: '目标产物不符合当前筛选条件' })).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  const target = page.locator('#artifact-artifact_1');
  await expect(target).toBeFocused();
  await expect(target).toHaveAttribute('aria-expanded', 'true');
  await expect(target.locator('..')).toContainText('Review report body for dashboard.');
});

test('approval evidence opens the exact audit event in the authenticated tab', async ({ page, server }) => {
  await page.goto(`${server.url}/advanced/approvals`);
  const link = page.locator('.link-strip a').filter({ hasText: 'human.decision.pending' }).first();
  await expect(link).toBeVisible();
  const text = (await link.innerText()).trim();
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/advanced\/runs\/run_1\/audit\?event=/);
  const eventId = new URL(page.url()).searchParams.get('event')!;
  const event = page.locator('.audit-item').filter({ has: page.getByText(eventId, { exact: true }) });
  await expect(event).toBeFocused();
  await expect(event.locator('.audit-type')).toHaveText(text);
  await expect(event.locator('pre')).toContainText('"decisionId": "decision_1"');
  await page.reload();
  await expect(event).toBeFocused();
  await expect(event.locator('pre')).toContainText('"decisionId": "decision_1"');
});

test('audit target reports missing events and preserves RPC error feedback', async ({ page, server }) => {
  await page.goto(`${server.url}/advanced/runs/run_1/audit?event=missing-event`);
  await expect(page.getByRole('status').filter({ hasText: '未找到该审计事件' })).toBeVisible();
  await page.route('**/api/rpc', async route => {
    if (route.request().postDataJSON().path === 'audit.list') {
      return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL', message: '审计读取失败，请重试' } } });
    }
    return route.continue();
  });
  await page.reload();
  await expect(page.getByText('审计读取失败，请重试', { exact: true })).toBeVisible();
  await expect(page.getByText('未找到该审计事件', { exact: true })).toHaveCount(0);
});

test('audit target hidden by filters is explained and can be revealed', async ({ page, server }) => {
  await page.goto(`${server.url}/advanced/runs/run_1`);
  await page.locator('.link-strip a').filter({ hasText: 'worktree.lease.created' }).first().click();
  await expect(page).toHaveURL(/\/audit\?event=/);
  const target = new URL(page.url());
  const eventId = target.searchParams.get('event')!;
  target.searchParams.set('node', 'nonexistent-node');
  await page.goto(target.href);
  await expect(page.getByRole('status').filter({ hasText: '目标事件不符合当前筛选条件' })).toBeVisible();
  await page.getByRole('button', { name: '✕ Clear', exact: true }).click();
  const event = page.locator('.audit-item').filter({ has: page.getByText(eventId, { exact: true }) });
  await expect(event).toBeFocused();
  await expect(event.locator('pre')).toContainText('"worktreePath"');
});

test('long audit event types remain inside the selected evidence row', async ({ page, server }) => {
  const longType = 'worktree.lease.created.' + 'extended_event_metadata_'.repeat(6);
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route('**/api/rpc', async route => {
    if (route.request().postDataJSON().path !== 'audit.list') return route.continue();
    const response = await route.fetch();
    const json = await response.json();
    json.result.events.find((event: { type: string }) => event.type === 'worktree.lease.created').type = longType;
    return route.fulfill({ response, json });
  });
  await page.goto(`${server.url}/advanced/runs/run_1`);
  await page.locator('.link-strip a').filter({ hasText: 'worktree.lease.created' }).first().click();
  const type = page.locator('.audit-type').filter({ hasText: longType });
  await expect(type).toHaveText(longType);
  expect(await type.evaluate(element => {
    const own = element.getBoundingClientRect();
    const card = element.closest('.card')!.getBoundingClientRect();
    const range = document.createRange(); range.selectNodeContents(element);
    return [...range.getClientRects()].every(rect => rect.left >= Math.max(own.left, card.left) - 1 && rect.right <= Math.min(own.right, card.right) + 1);
  })).toBe(true);
});

test('same-document target changes refocus while unchanged targets keep keyboard focus', async ({ page, server }) => {
  await page.goto(`${server.url}/advanced/runs/run_1/audit?event=missing`);
  await expect(page.getByRole('status').filter({ hasText: '未找到该审计事件' })).toBeVisible();
  const id = (await page.locator('.audit-item').first().getAttribute('id'))!.slice(6);
  // Exercise React Router's browser-history input without remounting AuditTab.
  const navigate = (event: string, node = '') => page.evaluate(({ event, node }) => {
    const url = new URL(location.href); url.searchParams.set('event', event);
    if (node) url.searchParams.set('node', node); else url.searchParams.delete('node');
    history.pushState(history.state, '', url);
    dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
  }, { event, node });
  await navigate(id);
  const target = page.locator('.audit-item').filter({ has: page.getByText(id, { exact: true }) });
  await expect(target).toBeFocused();
  const control = page.locator('.toolbar select').first();
  await control.focus();
  await navigate(id);
  await expect(control).toBeFocused();
  await navigate('another-missing-event');
  await expect(page.getByRole('status').filter({ hasText: '未找到该审计事件' })).toBeVisible();
  await navigate(id);
  await expect(target).toBeFocused();
  await navigate(id, 'hidden-node');
  await expect(page.getByRole('status').filter({ hasText: '目标事件不符合当前筛选条件' })).toBeVisible();
  await page.getByRole('button', { name: '✕ Clear', exact: true }).click();
  await expect(target).toBeFocused();
});
