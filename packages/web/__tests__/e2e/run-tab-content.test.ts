import { expect, test } from './shared-fixture.js';

test.describe('Run detail tab content', () => {
  test('overview tab shows run header and basic info', async ({ page, server }) => {
    await page.goto(`${server.url}/advanced/runs/run_1`);

    // Run header shows run ID
    await expect(page.locator('.run-header-id')).toHaveText('run_1');

    // Overview tab is active by default
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
  });

  test('artifacts tab shows artifact list', async ({ page, server }) => {
    await page.goto(`${server.url}/advanced/runs/run_1/artifacts`);

    await expect(
      page.getByRole('link', { name: 'Artifacts' }),
    ).toBeVisible();

    // Artifact type is displayed
    await expect(
      page.getByText('review-report', { exact: true }),
    ).toBeVisible();
  });

  test('gates tab shows gate results', async ({ page, server }) => {
    await page.goto(`${server.url}/advanced/runs/run_1/gates`);

    await expect(page.getByRole('link', { name: 'Gates' })).toBeVisible();

    // Gate type is shown (localized: the human gate renders as 人工审批).
    await expect(page.getByText('人工审批', { exact: true })).toBeVisible();
  });

  test('audit tab shows audit events', async ({ page, server }) => {
    await page.goto(`${server.url}/advanced/runs/run_1/audit`);

    await expect(page.getByRole('link', { name: 'Audit' })).toBeVisible();

    // Audit event for this run is visible
    await expect(
      page.getByText('human.decision.pending', { exact: true }),
    ).toBeVisible();
  });

  test('progress tab loads without errors', async ({ page, server }) => {
    await page.goto(`${server.url}/advanced/runs/run_1/progress`);

    await expect(
      page.getByRole('link', { name: 'Progress' }),
    ).toBeVisible();
  });

  test('run detail page shows error for non-existent run', async ({ page, server }) => {
    await page.goto(`${server.url}/advanced/runs/non-existent-run-id`);

    // Lock the actual API error rather than matching unrelated page text such
    // as a temporary project path that happens to contain "error".
    await expect(
      page.getByText('Run not found: non-existent-run-id', { exact: true }),
    ).toBeVisible();
  });
});
