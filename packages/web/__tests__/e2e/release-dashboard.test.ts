import { expect, test } from './shared-fixture.js';

test.describe('Tekon release dashboard', () => {
  test('delivery pipeline display, PR preparation, and desktop screenshot', async ({
    page,
    server,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    // ── 1. Navigate to /runs/run_1/delivery (delivery tab) ────────────────
    await page.goto(`${server.url}/runs/run_1/delivery`);

    // Breadcrumb renders
    await expect(page.getByText('运行列表 Runs')).toBeVisible();

    // Delivery tab content renders with the pipeline card
    await expect(
      page.getByText('交付管道 Delivery Pipeline'),
    ).toBeVisible();

    // Pipeline step labels are visible (steps rendered inside .delivery-step)
    const stepLabels = page.locator('.delivery-label');
    await expect(stepLabels).toHaveCount(5);
    await expect(stepLabels.nth(0)).toContainText('Workflow');
    await expect(stepLabels.nth(1)).toContainText('PR Prepared');
    await expect(stepLabels.nth(2)).toContainText('Awaiting');
    await expect(stepLabels.nth(4)).toContainText('PR Create');

    // PR Body and PR Package preview cards render (Card uses span.card-title, not headings)
    await expect(
      page.getByText('PR Package', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('PR Body', { exact: true }),
    ).toBeVisible();

    // ── 2. Navigate to the top-level /delivery page ───────────────────────
    await page.goto(`${server.url}/delivery`);

    await expect(
      page.getByRole('heading', { name: 'Delivery' }),
    ).toBeVisible();

    // Delivery Pipeline card renders on the full page too
    await expect(
      page.getByText('交付管道 Delivery Pipeline'),
    ).toBeVisible();

    // ── 3. Verify "Prepare PR" button exists ──────────────────────────────
    await expect(
      page.getByRole('button', { name: 'Prepare PR' }),
    ).toBeVisible();

    // Button is disabled because the fixture run is paused (not passed) and
    // no session token is provided.
    await expect(
      page.getByRole('button', { name: 'Prepare PR' }),
    ).toBeDisabled();

    // Token hint is shown when no token is entered
    await expect(
      page.getByText('Session token required for delivery actions'),
    ).toBeVisible();

    // ── 4. Enter token and verify Prepare PR becomes actionable ───────────
    // The workflow is paused so canPrepare is still false, but the token hint
    // should disappear once we provide a token.
    await page.getByLabel('Session token').fill(fixture.sessionToken);
    await expect(
      page.getByText('Session token required for delivery actions'),
    ).not.toBeVisible();

    // "Create PR" button is visible — disabled because the fixture run has
    // a paused workflow status (not passed/completed) and readiness checks
    // are not met, even though PR body/package files exist and no prUrl is set.
    await expect(
      page.getByRole('button', { name: 'Create PR' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create PR' }),
    ).toBeDisabled();

    // ── 5. Desktop screenshot ─────────────────────────────────────────────
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath('tekon-delivery-desktop.png'),
    });
  });
});
