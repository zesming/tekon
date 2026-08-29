import { test, expect } from './shared-fixture.js';

// T4 / T7: E2E test for TopBar connection status presentation, popover panel, and keyboard control.

test('TopBar connection panel opens, reveals token, closes on Escape or backdrop', async ({
  page,
  server,
  fixture,
}) => {
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });

  const statusBtn = page.getByRole('button', { name: /已连接/ });
  await expect(statusBtn).toBeVisible();
  await expect(statusBtn).toHaveAttribute('aria-expanded', 'false');

  // 1. Click to open connection panel
  await statusBtn.click();
  await expect(statusBtn).toHaveAttribute('aria-expanded', 'true');

  const panel = page.getByRole('dialog', { name: '连接管理' });
  await expect(panel).toBeVisible();

  const tokenInput = page.getByLabel('Session token');
  await expect(tokenInput).toBeVisible();
  await expect(tokenInput).toHaveValue(fixture.sessionToken);

  // 2. Toggle mask
  const maskBtn = page.getByRole('button', { name: '显示会话令牌' });
  await expect(maskBtn).toBeVisible();
  await maskBtn.click();
  await expect(tokenInput).toHaveAttribute('type', 'text');
  await expect(
    page.getByRole('button', { name: '隐藏会话令牌' }),
  ).toBeVisible();

  // 3. Escape key closes panel and restores focus
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(statusBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(statusBtn).toBeFocused();
});
