import { test, expect } from './shared-fixture.js';

for (const entry of ['simple', 'advanced'] as const) {
  test(`${entry}: refresh preserves the previous plan through loading and requires explicit submission`, async ({ page, server }) => {
    let revision = 1;
    let comparisonScope = 'r24-instance-one';
    let releaseRefresh!: () => void;
    let delayRefresh = false;
    const refreshGate = new Promise<void>((resolve) => { releaseRefresh = resolve; });
    const submissions: string[] = [];
    await page.route('**/api/rpc', async (route) => {
      const body = route.request().postDataJSON();
      if (body.path === 'project.run') {
        submissions.push(body.input.planDigest);
        return route.fulfill({ status: 400, json: { error: { code: 'BAD_REQUEST', message: '测试结束，未创建运行' } } });
      }
      if (body.path !== 'workflow.plan') return route.continue();
      const response = await route.fetch();
      const payload = await response.json();
      if (delayRefresh) await refreshGate;
      return route.fulfill({ json: { result: {
        ...payload.result, digestVersion: 3, digest: `r24-plan-${revision}`, comparisonScope,
        gates: [{ nodeId: 'qa-acceptance', gateIndex: 0, role: 'qa', type: 'test', requiresHumanApproval: false,
          commandBinding: { status: 'resolved', source: 'repo-profile', commandRef: 'test', behavior: 'execute-command', fingerprint: `r24-opaque-${revision}` } }],
      } } });
    });
    await page.goto(entry === 'simple' ? `${server.url}/` : `${server.url}/advanced/runs`);
    if (entry === 'advanced') await page.getByRole('button', { name: '新建运行' }).click();
    const input = entry === 'simple' ? page.getByLabel('新建受控交付任务') : page.locator('#start-run-demand');
    const submit = page.getByRole('button', { name: entry === 'simple' ? '启动受控交付' : '发起运行' });
    await input.fill('核对检查配置变化后再启动');
    const panel = page.getByTestId('plan-command-bindings');
    await expect(panel).toContainText('将执行已绑定命令');
    revision = 2;
    delayRefresh = true;
    await page.getByRole('button', { name: '刷新检查配置' }).click();
    await expect(submit).toBeDisabled();
    releaseRefresh();
    await expect(panel).toContainText('检查配置已变化');
    await expect(panel).toContainText('qa-acceptance');
    expect(submissions).toEqual([]);
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByText('测试结束，未创建运行')).toBeVisible();
    expect(submissions).toEqual(['r24-plan-2']);

    // Same-document credential replacement must hide the previous context's
    // difference immediately, although this public plan key itself is cached.
    await page.evaluate(() => { window.location.hash = 'token=r24-other-preview-token'; });
    await expect(page).not.toHaveURL(/token=/);
    await expect(panel).not.toContainText('检查配置已变化');

    comparisonScope = 'r24-instance-two';
    delayRefresh = false;
    await page.getByRole('button', { name: '刷新检查配置' }).click();
    await expect(panel).toContainText('暂无逐项变化信息');
    await expect(panel).not.toContainText('检查配置已变化');
    await expect(panel).not.toContainText('检查配置未变化');
  });
}

for (const width of [320, 390, 700, 1440]) {
  test(`R24 ${width}px: both entry previews expose actual Gate behavior without clipped controls`, async ({ page, server }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    await page.route('**/api/rpc', async (route) => {
      if (route.request().postDataJSON().path !== 'workflow.plan') return route.continue();
      const response = await route.fetch();
      const payload = await response.json();
      return route.fulfill({ json: { result: {
        ...payload.result, digestVersion: 3, comparisonScope: 'r24-responsive',
        gates: [
          { nodeId: 'rd-build', type: 'build', behavior: 'skip', status: 'resolved', commandRef: 'build' },
          { nodeId: 'qa-test', type: 'test', behavior: 'missing-command', status: 'missing', commandRef: 'test' },
          { nodeId: 'review-security', type: 'security-scan', behavior: 'builtin-security', status: 'not-applicable', commandRef: 'security' },
        ].map((gate) => ({ nodeId: gate.nodeId, type: gate.type, gateIndex: 0, role: 'qa', requiresHumanApproval: false,
          commandBinding: { source: 'repo-profile', status: gate.status, commandRef: gate.commandRef, behavior: gate.behavior, fingerprint: `opaque-${gate.nodeId}` } })),
      } } });
    });
    for (const entry of ['simple', 'advanced']) {
      await page.goto(entry === 'simple' ? `${server.url}/` : `${server.url}/advanced/runs`);
      if (entry === 'advanced') await page.getByRole('button', { name: '新建运行' }).click();
      const panel = page.getByTestId('plan-command-bindings');
      await panel.locator('summary').click();
      await expect(panel).toContainText('将跳过此检查');
      await expect(panel).toContainText('缺少命令，检查将失败');
      await expect(panel).toContainText('仍执行内置安全扫描');
      const refresh = panel.getByRole('button', { name: '刷新检查配置' });
      await refresh.scrollIntoViewIfNeeded();
      await refresh.focus();
      await expect(refresh).toBeFocused();
      await refresh.click({ trial: true });
      const geometry = await panel.evaluate((root) => {
        const rect = root.getBoundingClientRect();
        return { left: rect.left, right: rect.right, viewport: innerWidth,
          clipped: [...root.querySelectorAll<HTMLElement>('button,summary')].some((el) => el.scrollWidth > el.clientWidth + 1),
          documentOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(geometry.clipped).toBe(false);
      expect(geometry.documentOverflow).toBe(false);
      // fullPage 截图保留固定栏的当前 viewport 位置；先回顶，避免长图中段
      // 出现覆盖正文的固定栏，采集与读者从顶部浏览一致的画面。
      await page.evaluate(async () => {
        window.scrollTo(0, 0);
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      });
      await page.screenshot({ path: info.outputPath(`r24-${width}-${entry}-bindings.png`), fullPage: true, animations: 'disabled' });
    }
  });
}
