import { test, expect } from './shared-fixture.js';

const longTriage = {
  gateId: 'layout-triage',
  nodeId: `reviewer-node-${'n'.repeat(180)}`,
  gateType: 'human',
  status: 'failed',
  classification: `classification-${'c'.repeat(180)}`,
  retry: 'not-recommended',
  summary: `Summary ${'s'.repeat(260)}`,
  suggestedCommand: `tekon resume --run-id ${'r'.repeat(220)}`,
  logHref: '#gate-log-layout-triage',
};

for (const width of [320, 1440]) {
  for (const allPassed of [false, true]) {
    test(`overview ${width}px shows each check once (allPassed=${allPassed})`, async ({ page, server }, info) => {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.route('**/api/rpc', async route => {
        if (route.request().postDataJSON().path !== 'review.get') return route.continue();
        const response = await route.fetch();
        const json = await response.json();
        json.result.readiness = {
          ...json.result.readiness,
          ready: allPassed,
          score: allPassed ? 1 : 0.5,
          checks: [
            { id: 'audit-chain-valid', passed: true, evidence: 'Audit chain verified', severity: 'required' },
            { id: 'workflow-passed', passed: allPassed, evidence: allPassed ? 'Workflow passed' : 'Workflow paused; resume the original run', severity: 'required' },
          ],
        };
        return route.fulfill({ response, json });
      });
      await page.goto(`${server.url}/advanced/runs/run_1`);
      await expect(page.locator('.check-list')).toHaveCount(1);
      await expect(page.locator('.check-item')).toHaveCount(2);
      const card = page.locator('.card').filter({ has: page.getByText('检查结果', { exact: true }) });
      await expect(card).toBeVisible();
      await expect(card).toContainText(`${allPassed ? 2 : 1}/2 通过`);
      await expect(card).toContainText('Audit chain verified');
      if (allPassed) {
        await expect(card.locator('.failed-checks-summary')).toHaveCount(0);
        await expect(card.locator('.check-icon.fail')).toHaveCount(0);
      } else {
        await expect(card.locator('.failed-checks-summary')).toBeVisible();
        await expect(card.locator('.check-item').first()).toContainText('Workflow paused; resume the original run');
        await expect(card.locator('.check-item').last()).toContainText('Audit chain verified');
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width + 1);
      await page.screenshot({ path: info.outputPath(`release-${width}-checks-${allPassed ? 'passed' : 'mixed'}.png`), fullPage: true, animations: 'disabled' });
    });
  }
}

for (const width of [320, 1440]) {
  test(`overview ${width}px keeps long gate failure triage content inside its card`, async ({ page, server }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.route('**/api/rpc', async route => {
      if (route.request().postDataJSON().path !== 'review.get') return route.continue();
      const response = await route.fetch();
      const json = await response.json();
      json.result.gateFailureTriage = [longTriage];
      return route.fulfill({ response, json });
    });

    await page.goto(`${server.url}/advanced/runs/run_1`);

    const section = page.locator('.section').filter({
      has: page.locator('.section-title').filter({ hasText: '门禁故障诊断' }),
    });
    const card = section.locator('.card').first();
    await expect(card).toBeVisible();
    const grid = card.locator('.card-body > div').first();
    const cells = grid.locator(':scope > span');
    await expect(cells).toHaveCount(10);

    const metrics = await grid.evaluate((element) => {
      const grid = element as HTMLElement;
      const card = grid.closest('.card') as HTMLElement | null;
      const cardRect = card?.getBoundingClientRect();
      const cellMetrics = [...grid.children].map((child) => {
        const cell = child as HTMLElement;
        const rect = cell.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          clientWidth: cell.clientWidth,
          scrollWidth: cell.scrollWidth,
          text: cell.textContent ?? '',
        };
      });
      return {
        card: cardRect ? { left: cardRect.left, right: cardRect.right } : null,
        grid: (() => {
          const rect = grid.getBoundingClientRect();
          return { left: rect.left, right: rect.right };
        })(),
        cells: cellMetrics,
      };
    });

    expect(metrics.card).not.toBeNull();
    expect(metrics.grid.left).toBeGreaterThanOrEqual(metrics.card!.left - 1);
    expect(metrics.grid.right).toBeLessThanOrEqual(metrics.card!.right + 1);

    const valueCells = [metrics.cells[1], metrics.cells[3], metrics.cells[7], metrics.cells[9]];
    for (const cell of valueCells) {
      expect(cell.left).toBeGreaterThanOrEqual(metrics.card!.left - 1);
      expect(cell.right).toBeLessThanOrEqual(metrics.card!.right + 1);
      expect(cell.scrollWidth).toBeLessThanOrEqual(cell.clientWidth + 1);
    }

    expect(metrics.cells[1].text).toContain(longTriage.nodeId);
    expect(metrics.cells[3].text).toContain(longTriage.classification);
    expect(metrics.cells[7].text).toContain(longTriage.summary);
    expect(metrics.cells[9].text).toContain(longTriage.suggestedCommand);
    await page.screenshot({
      path: info.outputPath(`release-${width}-gate-triage-layout.png`),
      fullPage: true,
      animations: 'disabled',
    });
  });
}
