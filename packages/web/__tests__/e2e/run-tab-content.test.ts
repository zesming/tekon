import { expect, test } from './shared-fixture.js';

test.describe('Run detail tab content', () => {
  test('overview tab shows run header and basic info', async ({ page, server }) => {
    await page.goto(`${server.url}/runs/run_1`);

    // Run header shows run ID
    await expect(page.locator('.run-header-id')).toHaveText('run_1');

    // Overview tab is active by default
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
  });

  test('artifacts tab shows artifact list', async ({ page, server }) => {
    await page.goto(`${server.url}/runs/run_1/artifacts`);

    await expect(
      page.getByRole('link', { name: 'Artifacts' }),
    ).toBeVisible();

    // Artifact type is displayed
    await expect(
      page.getByText('review-report', { exact: true }),
    ).toBeVisible();
  });

  test('gates tab shows gate results', async ({ page, server }) => {
    await page.goto(`${server.url}/runs/run_1/gates`);

    await expect(page.getByRole('link', { name: 'Gates' })).toBeVisible();

    // Gate type is shown
    await expect(page.getByText('human', { exact: true })).toBeVisible();
  });

  test('audit tab shows audit events', async ({ page, server }) => {
    await page.goto(`${server.url}/runs/run_1/audit`);

    await expect(page.getByRole('link', { name: 'Audit' })).toBeVisible();

    // Audit event for this run is visible
    await expect(
      page.getByText('human.decision.pending', { exact: true }),
    ).toBeVisible();
  });

  test('progress tab loads without errors', async ({ page, server }) => {
    await page.goto(`${server.url}/runs/run_1/progress`);

    await expect(
      page.getByRole('link', { name: 'Progress' }),
    ).toBeVisible();
  });

  test('run detail page shows error for non-existent run', async ({ page, server }) => {
    await page.goto(`${server.url}/runs/non-existent-run-id`);

    // Error page or error message should be visible
    await expect(page.getByText(/not found|404|不存在|错误/)).toBeVisible();
  });
});
