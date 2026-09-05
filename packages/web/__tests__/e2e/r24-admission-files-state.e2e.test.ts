import { test, expect } from './shared-fixture.js';

for (const entry of ['simple', 'advanced'] as const) {
  test(`${entry}: POST pending and GET directory states remain distinct after ledger reload`, async ({ page, server }) => {
    let filesState: 'pending' | 'recovery_required' = 'pending';
    let requestId = '';
    await page.route('**/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.path === 'project.admission') {
        expect(body.input.requestId).toBe(requestId);
        return route.fulfill({ json: { result: { requestId, state: 'recovery-required', filesState, runId: 'run_1', sessionId: 'session-directory-state' } } });
      }
      if (body.path !== 'project.run') return route.continue();
      requestId = body.input.requestId;
      return route.fulfill({ json: { result: {
        requestId, replayed: false, admissionState: 'recovery-required', sessionId: 'session-directory-state',
        run: { id: 'run_1', projectId: 'project', demandId: 'demand', demandTitle: null, provider: 'mock', status: 'running', currentNodeId: null, createdAt: '', updatedAt: '', filesState: 'pending' },
      } } });
    });
    await page.goto(entry === 'simple' ? server.url : `${server.url}/advanced/runs`);
    if (entry === 'advanced') await page.getByRole('button', { name: '新建运行' }).click();
    await (entry === 'simple' ? page.getByLabel('新建受控交付任务') : page.getByLabel('需求描述', { exact: true })).fill('区分受理与目录准备阶段');
    await page.getByRole('button', { name: entry === 'simple' ? '启动受控交付' : '发起运行' }).click();
    const notice = page.getByTestId('admission-notice');
    await expect(notice.locator('strong')).toHaveText('已受理，等待目录就绪');
    await expect(notice).not.toContainText('修复目录');
    await expect(notice).not.toContainText('重启');
    const keys = await page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith('tekon.run-admissions.')).flatMap((key) => JSON.parse(sessionStorage.getItem(key)!) as Array<Record<string, unknown>>).map((record) => Object.keys(record).sort()));
    expect(keys).toEqual([['fingerprint', 'requestId', 'scope', 'state']]);

    await page.reload();
    await expect(notice.locator('strong')).toHaveText('已受理，目录状态待确认');
    await expect(notice).not.toContainText('修复目录');
    await notice.getByRole('button', { name: '查询受理结果' }).click();
    await expect(notice.locator('strong')).toHaveText('已受理，等待目录就绪');
    await expect(notice).not.toContainText('重启');
    filesState = 'recovery_required';
    await notice.getByRole('button', { name: '查询受理结果' }).click();
    await expect(notice.locator('strong')).toHaveText('已受理，等待目录恢复');
    await expect(notice).toContainText('修复目录');
    await expect(notice).toContainText('重启');
  });

  test(`${entry}: an unknown request and a not-found lookup never claim accepted directory preparation`, async ({ page, server }) => {
    await page.route('**/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.path === 'project.run') return route.fulfill({ status: 500, json: { error: { code: 'INTERNAL_ERROR', message: '请求结果暂不可用' } } });
      if (body.path === 'project.admission') return route.fulfill({ json: { result: { requestId: body.input.requestId, state: 'not-found' } } });
      return route.continue();
    });
    await page.goto(entry === 'simple' ? server.url : `${server.url}/advanced/runs`);
    if (entry === 'advanced') await page.getByRole('button', { name: '新建运行' }).click();
    await (entry === 'simple' ? page.getByLabel('新建受控交付任务') : page.getByLabel('需求描述', { exact: true })).fill('保留未确认请求身份');
    await page.getByRole('button', { name: entry === 'simple' ? '启动受控交付' : '发起运行' }).click();
    const notice = page.getByTestId('admission-notice');
    await expect(notice.locator('strong')).toHaveText('受理状态待确认');
    await notice.getByRole('button', { name: '查询受理结果' }).click();
    await expect(notice).toContainText('当前尚未查到记录');
    await expect(notice.locator('strong')).toHaveText('受理状态待确认');
    await expect(notice).not.toContainText('等待目录');
    await expect(notice).not.toContainText('修复目录');
  });
}
