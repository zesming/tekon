import { test, expect } from './shared-fixture.js';

// True lock for the cross-navigation token bootstrap fix (shared-fixture.ts).
//
// The `page` fixture injects `#token=` on every cross-document navigation so a
// business journey never depends on the previous document's sessionStorage
// write having committed. This test locks that contract *deterministically*
// rather than probabilistically:
//
//   1. We install a document-start init script that wipes sessionStorage on the
//      next navigation, removing the fallback token before `main.tsx` runs.
//   2. We navigate to a business route.
//
// With the fix, the injected `#token=` fragment is the sole surviving token
// source and `main.tsx` reads it synchronously → the first-paint RPC is
// authenticated → real content renders. Revert the fixture injection and this
// test fails deterministically (no fragment, no sessionStorage → guaranteed
// 401 auth-error page), so it can never silently pass as a dead test.
test('a business navigation authenticates from the injected token fragment even with empty sessionStorage', async ({
  page,
  server,
}) => {
  // Wipe the sessionStorage fallback at document-start of the next navigation
  // (runs before main.tsx reads it). Using addInitScript rather than
  // page.evaluate avoids touching the current document, which can be mid-
  // navigation (about:blank) and reject a synchronous sessionStorage access.
  await page.addInitScript(() => {
    try {
      window.sessionStorage.clear();
    } catch {
      // Ignore storage access errors; the injected fragment is the token source.
    }
  });

  await page.goto(`${server.url}/advanced/runs/run_1`);

  // Positive first: the authenticated route renders real content. This proves
  // the first-paint RPC carried a token (review.get returned 200), which only
  // holds when the fragment injection worked with sessionStorage empty.
  await expect(page.locator('.run-header-id')).toHaveText('run_1', {
    timeout: 15_000,
  });

  // Negative after the positive settles: the UNAUTHORIZED auth-error banner
  // (ErrorBanner "认证失败，无法访问") is absent. A regex on a stable substring
  // avoids coupling to the full copy.
  await expect(page.getByText(/认证失败/u)).toHaveCount(0);
});
