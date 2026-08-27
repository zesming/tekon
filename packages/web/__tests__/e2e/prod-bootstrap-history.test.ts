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
