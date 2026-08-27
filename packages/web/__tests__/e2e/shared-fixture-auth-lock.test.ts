import { test, expect } from './shared-fixture.js';

// Lock the production cross-document authentication path used after the first
// `tekon ui` bootstrap. The shared beforeEach opens `/#token=...`; `main.tsx`
// must persist that credential before the first render. A later hard navigation
// intentionally carries no fragment, so the new document can authenticate only
// by reading the real sessionStorage fallback.
test('a hard business navigation authenticates from the persisted token without rewriting the URL', async ({
  page,
  server,
  fixture,
}) => {
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.sessionStorage.getItem('tekon.sessionToken'),
      ),
    )
    .toBe(fixture.sessionToken);

  await page.goto(`${server.url}/advanced/runs/run_1`);

  // The destination URL remains the URL the test requested: no fixture adds a
  // credential fragment, so this exercises the same sessionStorage fallback a
  // user gets after a refresh or direct hard navigation within the tab.
  await expect(page).not.toHaveURL(/token=/u);
  await expect(page.locator('.run-header-id')).toHaveText('run_1', {
    timeout: 15_000,
  });
  await expect(page.getByText(/认证失败/u)).toHaveCount(0);
  const persistedToken = await page.evaluate(() =>
    window.sessionStorage.getItem('tekon.sessionToken'),
  );
  expect(persistedToken).toBe(fixture.sessionToken);
});
