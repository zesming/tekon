import { expect, test } from './shared-fixture.js';

test.describe('Tekon release dashboard', () => {
  test('delivery pipeline display, PR preparation, and desktop screenshot', async ({
    page,
    server,
    fixture,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });

    // ── 1. Navigate to /runs/run_1/delivery (delivery tab) ────────────────
    await page.goto(`${server.url}/advanced/runs/run_1/delivery`);

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
    await page.goto(`${server.url}/advanced/delivery`);

    await expect(
      page.getByRole('heading', { name: 'Delivery' }),
    ).toBeVisible();

    // Delivery Pipeline card renders on the full page too
    await expect(
      page.getByText('交付管道 Delivery Pipeline'),
    ).toBeVisible();

    // ── 3. Verify authenticated delivery affordances ─────────────────────
    await expect(page.getByLabel('Session token')).toHaveValue(
      fixture.sessionToken,
    );
    await expect(
      page.getByRole('button', { name: 'Prepare PR' }),
    ).toBeVisible();

    // The fixture run is paused, so readiness keeps Prepare PR disabled even
    // though the normal connected credential is present.
    await expect(
      page.getByRole('button', { name: 'Prepare PR' }),
    ).toBeDisabled();
    await expect(
      page.getByText('Session token required for delivery actions'),
    ).not.toBeVisible();

    // "Create PR" remains disabled because the fixture run has a paused
    // workflow status and readiness checks are not met.
    await expect(
      page.getByRole('button', { name: 'Create PR' }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: 'Create PR' }),
    ).toBeDisabled();

    // ── 4. Desktop screenshot ─────────────────────────────────────────────
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath('tekon-delivery-desktop.png'),
    });
  });
});
