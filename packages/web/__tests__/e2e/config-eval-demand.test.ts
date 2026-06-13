import { expect, test } from './shared-fixture.js';

test.describe('Config, Eval, and Demand pages', () => {
  // ── Config page ────────────────────────────────────────────────────────

  test('config page loads with Roles, Workflows, and Constraints tabs', async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/config`);

    await expect(page.getByText('Config', { exact: true })).toBeVisible();

    // Tab navigation links are present
    await expect(page.getByRole('link', { name: 'Roles' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Workflows' })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Constraints' }),
    ).toBeVisible();

    // Default tab: Roles — fixture RD role is visible
    await expect(page.getByText('rd', { exact: true })).toBeVisible();

    // Navigate to Workflows tab
    await page.getByRole('link', { name: 'Workflows' }).click();
    await page.waitForURL('**/config/workflows');
    await expect(
      page.getByText('project-feature', { exact: true }),
    ).toBeVisible();

    // Navigate to Constraints tab
    await page.getByRole('link', { name: 'Constraints' }).click();
    await page.waitForURL('**/config/constraints');
  });

  // ── Eval page ──────────────────────────────────────────────────────────

  test('eval page loads with Readiness, Demand Shape, Approval Summary, and Workflow Selection tabs', async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/eval`);

    await expect(
      page.getByText('Evaluations', { exact: true }),
    ).toBeVisible();

    // All eval tabs are present
    await expect(page.getByRole('link', { name: 'Readiness' })).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Demand Shape' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Approval Summary' }),
    ).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Workflow Selection' }),
    ).toBeVisible();

    // Navigate to Demand Shape tab
    await page.getByRole('link', { name: 'Demand Shape' }).click();
    await page.waitForURL('**/eval/demand-shape');

    // Navigate to Approval Summary tab
    await page.getByRole('link', { name: 'Approval Summary' }).click();
    await page.waitForURL('**/eval/approval-summary');

    // Navigate to Workflow Selection tab
    await page.getByRole('link', { name: 'Workflow Selection' }).click();
    await page.waitForURL('**/eval/workflow-selection');
  });

  // ── Demand page ────────────────────────────────────────────────────────

  test('demand page loads', async ({ page, server }) => {
    await page.goto(`${server.url}/demand`);

    // Demand page renders with page title containing "Demand"
    await expect(page.locator('.page-title')).toContainText('Demand');
  });
});
