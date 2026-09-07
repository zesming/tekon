import { test, expect } from './shared-fixture.js';

// Phase 3 3d: route migration. The human-first Session UI is the default (`/`);
// the legacy Cockpit is preserved under /advanced. The default launch surface
// must also expose a server-derived execution plan before a user can start the
// full controlled-delivery workflow.

test('default route is the Session UI with a run plan; legacy Cockpit lives at /advanced', async ({
  page,
  server,
}) => {
  // Default route → Session UI (not the old dashboard).
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });

  const plan = page.getByRole('region', { name: '执行前计划' });
  await expect(plan).toBeVisible();
  await expect(plan).toContainText('执行链路');
  await expect(plan).toContainText('控制点');
  await expect(
    page.getByRole('button', { name: '启动受控交付' }),
  ).toBeDisabled();

  // The legacy Cockpit dashboard is preserved under /advanced.
  await page.goto(`${server.url}/advanced`);
  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
    timeout: 15_000,
  });

  // Old run list still reachable under /advanced (nothing deleted, C2).
  await page.goto(`${server.url}/advanced/runs`);
  await expect(
    page.getByRole('heading', { name: '运行管理 Runs' }),
  ).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('run_1', { exact: true })).toBeVisible();

  // The sidebar exposes both entry points.
  await expect(page.getByRole('link', { name: '受控交付' })).toBeVisible();
  await expect(page.getByRole('link', { name: '高级 Advanced' })).toBeVisible();
});
