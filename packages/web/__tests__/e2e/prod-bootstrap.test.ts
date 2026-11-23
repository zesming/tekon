import { test, expect } from './prod-bootstrap-fixture.js';

// Production browser bootstrap: `tekon ui` prints a URL with the session token
// in the fragment (`/#token=<token>`). The client must capture it synchronously
// before first paint, strip it from the URL, persist across refresh via
// sessionStorage, and never leak it in request URLs or Referer headers.

test('first paint authenticates from the #token fragment (no manual paste)', async ({
  page,
  server,
  fixture,
}) => {
  const bootstrapUrl = `${server.url}/#token=${encodeURIComponent(
    fixture.sessionToken,
  )}`;

  const unauthorized: string[] = [];
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (err) => {
    pageErrors.push(err.message);
  });
  page.on('response', (response) => {
    const url = response.url();
    if (
      (url.includes('/api/rpc') ||
        url.includes('/api/sessions') ||
        url.includes('/api/workspaces')) &&
      response.status() === 401
    ) {
      unauthorized.push(url);
    }
  });

  await page.goto(bootstrapUrl);

  await expect(page.getByTestId('new-task-hero')).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByLabel('选择工作流模板').locator('option[value="deep-research"]'),
  ).toBeAttached({ timeout: 15_000 });
  expect(unauthorized, `unexpected 401s: ${unauthorized.join(', ')}`).toEqual(
    [],
  );
  expect(consoleErrors, `unexpected console/CSP errors: ${consoleErrors.join(' | ')}`).toEqual([]);
  expect(pageErrors, `unexpected page errors: ${pageErrors.join(' | ')}`).toEqual([]);
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
  await expect(
    page.getByLabel('选择工作流模板').locator('option[value="deep-research"]'),
  ).toBeAttached({ timeout: 15_000 });

  const unauthorized: string[] = [];
  page.on('response', (response) => {
    const url = response.url();
    if (
      (url.includes('/api/rpc') ||
        url.includes('/api/sessions') ||
        url.includes('/api/workspaces')) &&
      response.status() === 401
    ) {
      unauthorized.push(url);
    }
  });

  await page.reload();
  await expect(page.getByTestId('new-task-hero')).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    page.getByLabel('选择工作流模板').locator('option[value="deep-research"]'),
  ).toBeAttached({ timeout: 15_000 });
  expect(unauthorized, `401s after refresh: ${unauthorized.join(', ')}`).toEqual(
    [],
  );
});

test('the token is never sent to the server in a request URL or Referer', async ({
  page,
  server,
  fixture,
}) => {
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
  await expect(
    page.getByLabel('选择工作流模板').locator('option[value="deep-research"]'),
  ).toBeAttached({ timeout: 15_000 });
  expect(leaks, `token leaked to server: ${leaks.join(', ')}`).toEqual([]);
});

test('an already-open tab accepts a fresh #token fragment without reloading', async ({
  page,
  server,
  fixture,
}) => {
  await page.goto(server.url);
  await expect(page.getByTestId('new-task-hero')).toBeVisible({
    timeout: 15_000,
  });

  await page.evaluate(() => {
    (window as Window & { __tekonBootstrapMarker?: string })
      .__tekonBootstrapMarker = 'mounted';
  });

  await page.evaluate((token) => {
    window.location.hash = new URLSearchParams({ token }).toString();
  }, fixture.sessionToken);

  await expect(
    page.getByLabel('选择工作流模板').locator('option[value="deep-research"]'),
  ).toBeAttached({ timeout: 15_000 });
  expect(page.url()).not.toContain('token=');
  expect(
    await page.evaluate(
      () =>
        (window as Window & { __tekonBootstrapMarker?: string })
          .__tekonBootstrapMarker,
    ),
  ).toBe('mounted');
});

test('legacy /advanced/* and /sessions/* routes redirect cleanly to workbench root', async ({
  page,
  server,
  fixture,
}) => {
  await page.goto(
    `${server.url}/advanced/runs#token=${encodeURIComponent(fixture.sessionToken)}`,
  );
  await expect(page.getByTestId('new-task-hero')).toBeVisible({
    timeout: 15_000,
  });
  expect(new URL(page.url()).pathname).toBe('/');
});
