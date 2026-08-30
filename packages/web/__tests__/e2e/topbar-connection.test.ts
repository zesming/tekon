import { test, expect } from './shared-fixture.js';
import {
  BUTTON_LABELS,
  CREDENTIAL_TEXT,
  credentialStatus,
  INPUT_LABELS,
} from './helpers/locators.js';

// T4 / T7: connection credentials are edited as a local draft and become
// active only after an explicit Apply action. The status label reports
// health from the server handshake (project.health).

test('TopBar connection panel applies credentials explicitly and supports keyboard control', async ({
  page,
  server,
  fixture,
}) => {
  await page.goto(server.url);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });

  const statusBtn = credentialStatus(page);
  await expect(statusBtn).toHaveAccessibleName(CREDENTIAL_TEXT.VALID);
  await expect(statusBtn).toHaveAttribute('aria-expanded', 'false');

  await statusBtn.click();
  await expect(statusBtn).toHaveAttribute('aria-expanded', 'true');

  const panel = page.getByRole('dialog', { name: '连接管理' });
  await expect(panel).toBeVisible();

  const tokenInput = page.getByLabel(INPUT_LABELS.SESSION_TOKEN);
  await expect(tokenInput).toBeFocused();
  await expect(tokenInput).toHaveValue(fixture.sessionToken);

  const maskBtn = page.getByRole('button', { name: BUTTON_LABELS.SHOW_TOKEN });
  await maskBtn.click();
  await expect(tokenInput).toHaveAttribute('type', 'text');

  // Clear the active credential, then type a replacement. Merely pausing while
  // typing must not silently activate the draft.
  await page.getByRole('button', { name: BUTTON_LABELS.CLEAR_CREDENTIAL }).click();
  await expect(statusBtn).toHaveAccessibleName(CREDENTIAL_TEXT.NOT_CONFIGURED);
  await tokenInput.fill('replacement-token');
  await page.waitForTimeout(500);
  await expect(statusBtn).toHaveAccessibleName(CREDENTIAL_TEXT.NOT_CONFIGURED);

  // Enter submits the form and applies the draft explicitly. The replacement
  // token does not match the server-side session configuration, so the
  // truthful handshake status is INVALID (not the old "configured" boolean).
  await tokenInput.press('Enter');
  await expect(panel).not.toBeVisible();
  await expect(statusBtn).toHaveAccessibleName(CREDENTIAL_TEXT.INVALID);
  await expect(statusBtn).toBeFocused();

  // Escape closes the panel and restores focus to the disclosure button.
  await statusBtn.click();
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(statusBtn).toHaveAttribute('aria-expanded', 'false');
  await expect(statusBtn).toBeFocused();
});
