import { test, expect } from './shared-fixture.js';

// T4 / T7: connection credentials are edited as a local draft and become
// active only after an explicit Apply action. The status label is deliberately
// truthful: it reports whether credentials are configured, not whether a
// server handshake has proven them valid.

test('TopBar connection panel applies credentials explicitly and supports keyboard control', async ({
  page,
  server,
  fixture,
}) => {
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });

  const statusBtn = page.getByRole('button', { name: /连接凭据/ });
  await expect(statusBtn).toHaveAccessibleName('连接凭据：已设置');
  await expect(statusBtn).toHaveAttribute('aria-expanded', 'false');

  await statusBtn.click();
  await expect(statusBtn).toHaveAttribute('aria-expanded', 'true');

  const panel = page.getByRole('dialog', { name: '连接管理' });
  await expect(panel).toBeVisible();

  const tokenInput = page.getByLabel('会话令牌 (Session token)');
  await expect(tokenInput).toBeFocused();
  await expect(tokenInput).toHaveValue(fixture.sessionToken);

  const maskBtn = page.getByRole('button', { name: '显示会话令牌' });
  await maskBtn.click();
  await expect(tokenInput).toHaveAttribute('type', 'text');

  // Clear the active credential, then type a replacement. Merely pausing while
  // typing must not silently activate the draft.
  await page.getByRole('button', { name: '清除凭据' }).click();
  await expect(statusBtn).toHaveAccessibleName('连接凭据：未设置');
  await tokenInput.fill('replacement-token');
  await page.waitForTimeout(500);
  await expect(statusBtn).toHaveAccessibleName('连接凭据：未设置');

  // Enter submits the form and applies the draft explicitly.
  await tokenInput.press('Enter');
  await expect(panel).not.toBeVisible();
  await expect(statusBtn).toHaveAccessibleName('连接凭据：已设置');
  await expect(statusBtn).toBeFocused();

  // Escape closes the panel and restores focus to the disclosure button.
  await statusBtn.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(statusBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(statusBtn).toBeFocused();
});
