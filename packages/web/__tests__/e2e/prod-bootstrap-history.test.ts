import { test, expect } from './prod-bootstrap-fixture.js';

test('stripping a bootstrap fragment preserves router history state', async ({
  page,
  server,
  fixture,
}) => {
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });

  await page.evaluate(() => {
    const current = window.history.state as Record<string, unknown> | null;
    window.history.replaceState(
      { ...current, __tekonHistorySentinel: 'preserved' },
      '',
      window.location.href,
    );
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
        (window.history.state as Record<string, unknown> | null)
          ?.__tekonHistorySentinel,
    ),
  ).toBe('preserved');
});
