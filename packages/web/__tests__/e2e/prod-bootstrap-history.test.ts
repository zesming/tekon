import { test, expect } from './prod-bootstrap-fixture.js';

test('stripping a bootstrap fragment preserves current router history state', async ({
  page,
  server,
  fixture,
}) => {
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });

  // Model an authenticated launch URL installed into the current entry (rather
  // than `location.hash = ...`, which intentionally creates a new entry whose
  // state is null). The hashchange handler must strip the credential without
  // replacing React Router's current idx/key/usr metadata.
  await page.evaluate((token) => {
    const current = window.history.state as Record<string, unknown> | null;
    window.history.replaceState(
      { ...current, __tekonHistorySentinel: 'preserved' },
      '',
      `/#${new URLSearchParams({ token }).toString()}`,
    );
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  }, fixture.sessionToken);

  await expect(page.getByLabel('Session token')).toHaveValue(
    fixture.sessionToken,
  );
  expect(page.url()).not.toContain('token=');
  expect(
    await page.evaluate(
      () =>
        (window.history.state as Record<string, unknown> | null)
          ?.__tekonHistorySentinel,
    ),
  ).toBe('preserved');
});

test('manual token fallback authenticates the first request for the new scope', async ({
  page,
  server,
  fixture,
}) => {
  // Let the anonymous first paint settle before observing the manual recovery.
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForLoadState('networkidle');

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

  // TopBar is the documented fallback when a user opened a bare URL. The RPC
  // credential must be updated synchronously before descendant query effects
  // issue the first request for the token-derived auth scope.
  await page.getByLabel('Session token').fill(fixture.sessionToken);

  await expect(page.getByText('还没有交付任务')).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForLoadState('networkidle');
  expect(
    unauthorized,
    `manual token recovery sent an unauthenticated request: ${unauthorized.join(', ')}`,
  ).toEqual([]);
});
