import { test, expect } from './shared-fixture.js';

// Phase 3 3d: route migration. The human-first Session UI is the default (`/`);
// the legacy Cockpit is preserved under /advanced (report C2 — dual-track,
// nothing deleted). Reconnect/replay stitching is unit-tested in
// session-stream-reconnect.test.ts (deterministic fake fetch); here we assert
// the routing contract holds in a real browser.

test('default route is the Session UI; legacy Cockpit lives at /advanced', async ({
  page,
  server,
}) => {
  // Default route → Session UI (not the old dashboard).
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });

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
