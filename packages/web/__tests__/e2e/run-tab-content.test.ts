import { expect, test } from '@playwright/test';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

test.describe('Run detail tab content', () => {
  let fixture: Awaited<ReturnType<typeof createWebFixtureProject>>;
  let server: RunningWebServer;

  test.beforeEach(async () => {
    fixture = await createWebFixtureProject();
    server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: true,
    });
    await server.listen();
  });

  test.afterEach(async () => {
    await server.close();
    fixture.cleanup();
  });

  test('overview tab shows run header and basic info', async ({ page }) => {
    await page.goto(`${server.url}/runs/run_1`);

    // Run header shows run ID
    await expect(page.locator('.run-header-id')).toHaveText('run_1');

    // Overview tab is active by default
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
  });

  test('artifacts tab shows artifact list', async ({ page }) => {
    await page.goto(`${server.url}/runs/run_1/artifacts`);

    await expect(
      page.getByRole('link', { name: 'Artifacts' }),
    ).toBeVisible();

    // Artifact type is displayed
    await expect(
      page.getByText('review-report', { exact: true }),
    ).toBeVisible();
  });

  test('gates tab shows gate results', async ({ page }) => {
    await page.goto(`${server.url}/runs/run_1/gates`);

    await expect(page.getByRole('link', { name: 'Gates' })).toBeVisible();

    // Gate type is shown
    await expect(page.getByText('human', { exact: true })).toBeVisible();
  });

  test('audit tab shows audit events', async ({ page }) => {
    await page.goto(`${server.url}/runs/run_1/audit`);

    await expect(page.getByRole('link', { name: 'Audit' })).toBeVisible();

    // Audit event for this run is visible
    await expect(
      page.getByText('human.decision.pending', { exact: true }),
    ).toBeVisible();
  });

  test('progress tab loads without errors', async ({ page }) => {
    await page.goto(`${server.url}/runs/run_1/progress`);

    await expect(
      page.getByRole('link', { name: 'Progress' }),
    ).toBeVisible();
  });

  test('run detail page shows error for non-existent run', async ({ page }) => {
    await page.goto(`${server.url}/runs/non-existent-run-id`);

    // Error page or error message should be visible
    await expect(page.getByText(/not found|404|不存在|错误/)).toBeVisible();
  });
});
