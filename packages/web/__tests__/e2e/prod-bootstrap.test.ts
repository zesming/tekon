import { test, expect } from './prod-bootstrap-fixture.js';

// F7-P0-01: the production browser bootstrap. `tekon ui` prints a URL with the
// session token in the fragment (`/#token=<token>`); the client must capture
// it so the default entry works WITHOUT the user hand-pasting the token, and
// keep it across a refresh. This suite uses a fixture that does NOT monkeypatch
// fetch (unlike shared-fixture.ts), so it fails if the bootstrap regresses —
// which is the whole point (the monkeypatch previously masked the 401).

test('first paint authenticates from the #token fragment (no manual paste)', async ({
  page,
  server,
  fixture,
}) => {
  const bootstrapUrl = `${server.url}/#token=${encodeURIComponent(
    fixture.sessionToken,
  )}`;

  // Fail the test if any authenticated read 401s — this is what a real user hit
  // before the fix (session.list / SSE returned 401 on first paint).
  const unauthorized: string[] = [];
  page.on('response', (response) => {
    const url = response.url();
    if (
      (url.includes('/api/rpc') || url.includes('/api/sessions')) &&
      response.status() === 401
    ) {
      unauthorized.push(url);
    }
  });

  await page.goto(bootstrapUrl);

  // The sessions page renders and the authenticated session.list resolves
  // (the empty-state or a list — either way not an auth error banner).
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForLoadState('networkidle');
  expect(unauthorized, `unexpected 401s: ${unauthorized.join(', ')}`).toEqual(
    [],
  );

  // The token was captured into state (the TopBar input is pre-filled) and the
  // fragment was stripped from the address bar.
  await expect(page.getByLabel('Session token')).toHaveValue(
    fixture.sessionToken,
  );
  expect(page.url()).not.toContain('token=');
});

test('the session survives a refresh via sessionStorage', async ({
  page,
  server,
  fixture,
}) => {
  await page.goto(
    `${server.url}/#token=${encodeURIComponent(fixture.sessionToken)}`,
  );
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });

  // Reload WITHOUT the fragment (it was already stripped). The token must
  // persist from sessionStorage so the entry stays usable.
  const unauthorized: string[] = [];
  page.on('response', (response) => {
    if (
      (response.url().includes('/api/rpc') ||
        response.url().includes('/api/sessions')) &&
      response.status() === 401
    ) {
      unauthorized.push(response.url());
    }
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForLoadState('networkidle');
  expect(unauthorized, `401s after refresh: ${unauthorized.join(', ')}`).toEqual(
    [],
  );
  await expect(page.getByLabel('Session token')).toHaveValue(
    fixture.sessionToken,
  );
});

test('the token is never sent to the server in a request URL or Referer', async ({
  page,
  server,
  fixture,
}) => {
  // Regression guard: the token lives in the fragment, which browsers never
  // send. If someone switches to `?token=` (query) or leaks it into Referer,
  // this fails.
  const leaks: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(fixture.sessionToken)) {
      leaks.push(`url:${request.url()}`);
    }
    const referer = request.headers()['referer'];
    if (referer && referer.includes(fixture.sessionToken)) {
      leaks.push(`referer:${referer}`);
    }
  });

  await page.goto(
    `${server.url}/#token=${encodeURIComponent(fixture.sessionToken)}`,
  );
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForLoadState('networkidle');
  expect(leaks, `token leaked to server: ${leaks.join(', ')}`).toEqual([]);
});


test('an already-open tab accepts a fresh #token fragment without reloading', async ({
  page,
  server,
  fixture,
}) => {
  // Start like a real stale/unauthenticated tab. The app is already mounted
  // before the user pastes the authenticated launch URL.
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByLabel('Session token')).toHaveValue('');

  await page.evaluate(() => {
    (window as Window & { __tekonBootstrapMarker?: string })
      .__tekonBootstrapMarker = 'mounted';
  });

  await page.evaluate((token) => {
    window.location.hash = new URLSearchParams({ token }).toString();
  }, fixture.sessionToken);

  await expect(page.getByLabel('Session token')).toHaveValue(
    fixture.sessionToken,
  );
  expect(page.url()).not.toContain('token=');
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __tekonBootstrapMarker?: string })
          .__tekonBootstrapMarker,
    ),
  ).toBe('mounted');

  const unauthorized: string[] = [];
  page.on('response', (response) => {
    if (
      (response.url().includes('/api/rpc') ||
        response.url().includes('/api/sessions')) &&
      response.status() === 401
    ) {
      unauthorized.push(response.url());
    }
  });

  const refreshed = page.waitForResponse(
    (response) =>
      response.url().includes('/api/rpc') && response.status() === 200,
  );
  await page.getByRole('button', { name: /刷新/ }).click();
  await refreshed;
  expect(
    unauthorized,
    `401s after same-document bootstrap: ${unauthorized.join(', ')}`,
  ).toEqual([]);
});
