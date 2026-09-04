import { test, expect } from './shared-fixture.js';
import {
  BUTTON_LABELS,
  CREDENTIAL_TEXT,
  credentialStatus,
  INPUT_LABELS,
} from './helpers/locators.js';

// T4 / T7: connection credentials are edited as a local draft and become
// active only after an explicit Apply action. The status label reports
// credential health from project.health and optional DSH status from project.providerHealth.

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
  await expect(statusBtn).toHaveAccessibleDescription(
    'dsh-headless 当前不可用；运行 tekon provider preflight dsh-headless 查看详情',
  );
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

test('credential status resolves before a delayed provider probe', async ({
  page,
  server,
}) => {
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => {
    markProviderStarted = resolve;
  });
  let releaseProvider!: () => void;
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { path?: string };
    if (body.path !== 'project.providerHealth') {
      await route.continue();
      return;
    }
    markProviderStarted();
    await providerGate;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        result: {
          provider: 'dsh-headless',
          status: 'unavailable',
          checkedAt: new Date().toISOString(),
        },
      }),
    });
  });

  // Use a distinct document URL so this is a hard navigation whether the
  // shared authentication hook ran in this worker or the page is still blank.
  await page.goto(`${server.url}/?provider-test=delayed`);
  await providerStarted;
  const statusBtn = credentialStatus(page);
  await expect(statusBtn).toHaveAccessibleName(CREDENTIAL_TEXT.VALID);
  await expect(statusBtn).not.toHaveAttribute('aria-describedby');

  releaseProvider();
  await expect(statusBtn).toHaveAccessibleDescription(
    'dsh-headless 当前不可用；运行 tekon provider preflight dsh-headless 查看详情',
  );
});

test('provider RPC failure does not downgrade valid credentials', async ({
  page,
  server,
}) => {
  let providerRequestCount = 0;
  let markProviderFailureHandled!: () => void;
  const providerFailureHandled = new Promise<void>((resolve) => {
    markProviderFailureHandled = resolve;
  });
  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as { path?: string };
    if (body.path !== 'project.providerHealth') {
      await route.continue();
      return;
    }
    providerRequestCount += 1;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        error: { code: 'INTERNAL_ERROR', message: 'provider probe failed' },
      }),
    });
    markProviderFailureHandled();
  });

  await page.goto(`${server.url}/?provider-test=failure`);
  await providerFailureHandled;
  expect(providerRequestCount).toBe(1);
  const statusBtn = credentialStatus(page);
  await expect(statusBtn).toHaveAccessibleName(CREDENTIAL_TEXT.VALID);
  await expect(statusBtn).not.toContainText('dsh-headless不可用');
});

test('token scope change hides old provider state before the new probe resolves', async ({
  page,
  server,
}) => {
  const replacementToken = 'replacement-valid-token';
  let replacementProbeStarted!: () => void;
  const replacementStarted = new Promise<void>((resolve) => {
    replacementProbeStarted = resolve;
  });
  let releaseReplacement!: () => void;
  const replacementGate = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });

  await page.route('**/api/rpc', async (route) => {
    const body = route.request().postDataJSON() as {
      path?: string;
      input?: { token?: string };
    };
    if (body.path === 'project.health' && body.input?.token === replacementToken) {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: { credential: 'valid', checkedAt: new Date().toISOString() },
        }),
      });
      return;
    }
    if (body.path === 'project.providerHealth') {
      if (body.input?.token === replacementToken) {
        replacementProbeStarted();
        await replacementGate;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            result: {
              provider: 'dsh-headless',
              status: 'available',
              checkedAt: new Date().toISOString(),
            },
          }),
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          result: {
            provider: 'dsh-headless',
            status: 'unavailable',
            checkedAt: new Date().toISOString(),
          },
        }),
      });
      return;
    }
    await route.continue();
  });

  await page.goto(`${server.url}/?provider-test=rotation`);
  const statusBtn = credentialStatus(page);
  await expect(statusBtn).toContainText('dsh-headless不可用');

  await statusBtn.click();
  const tokenInput = page.getByLabel(INPUT_LABELS.SESSION_TOKEN);
  await tokenInput.fill(replacementToken);
  await tokenInput.press('Enter');
  await replacementStarted;
  await expect(statusBtn).toHaveAccessibleName(CREDENTIAL_TEXT.VALID);
  await expect(statusBtn).not.toContainText('dsh-headless不可用');

  releaseReplacement();
  await expect(statusBtn).not.toContainText('dsh-headless不可用');
});
