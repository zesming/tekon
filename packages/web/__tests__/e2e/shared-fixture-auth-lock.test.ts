import { test, expect } from './shared-fixture.js';

// Lock the shared business-suite launch policy. Each hard navigation to a deep
// same-origin route must carry the production #token fragment, so the route's
// first-paint RPC is authenticated even when no sessionStorage fallback exists.
// This test intentionally validates the fixture policy; prod-bootstrap.test.ts
// separately validates the real product refresh/sessionStorage behavior.
test('a deep-route launch authenticates from the injected token fragment when sessionStorage is empty', async ({
  page,
  server,
}) => {
  await page.addInitScript(() => {
    try {
      window.sessionStorage.clear();
    } catch {
      // The fragment remains the authoritative source for this launch.
    }
  });

  await page.goto(`${server.url}/advanced/runs/run_1`);

  await expect(page.locator('.run-header-id')).toHaveText('run_1', {
    timeout: 15_000,
  });
  await expect(page.getByText(/认证失败/u)).toHaveCount(0);
  // The application consumes and removes the credential fragment after the
  // first-paint client has synchronously seeded RPC/SSE authentication.
  await expect(page).not.toHaveURL(/token=/u);
});
