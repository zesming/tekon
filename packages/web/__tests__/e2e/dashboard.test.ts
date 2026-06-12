import { expect, test } from '@playwright/test';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

test.describe('Tekon main flow', () => {
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

  test('dashboard, run list, run detail tabs, approvals, and token-required operations', async ({
    page,
  }) => {
    // ── 1. Dashboard page loads with sidebar ──────────────────────────────
    await page.goto(server.url);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Tekon', { exact: true })).toBeVisible();
    await expect(page.getByText('Cockpit', { exact: true })).toBeVisible();

    // Sidebar navigation items are present
    await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByRole('link', { name: '运行列表' })).toBeVisible();
    await expect(page.getByRole('link', { name: '审批队列' })).toBeVisible();

    // Dashboard stat cards render
    await expect(page.getByText('运行 Runs')).toBeVisible();
    await expect(page.getByText('通过率 Pass Rate')).toBeVisible();

    // ── 2. Navigate to /runs → run list renders ───────────────────────────
    await page.getByRole('link', { name: '运行列表' }).click();
    await page.waitForURL('**/runs');

    await expect(
      page.getByRole('heading', { name: '运行管理 Runs' }),
    ).toBeVisible();

    // Both fixture runs appear in the table
    await expect(page.getByText('run_1', { exact: true })).toBeVisible();
    await expect(page.getByText('run_0', { exact: true })).toBeVisible();

    // ── 3. Click a run → navigate to /runs/:runId ─────────────────────────
    await page.getByText('run_1', { exact: true }).click();
    await page.waitForURL('**/runs/run_1');

    // Breadcrumb renders and run header shows the run ID
    await expect(page.getByText('运行列表 Runs')).toBeVisible();
    await expect(page.locator('.run-header-id')).toHaveText('run_1');

    // ── 4. Tab navigation works ───────────────────────────────────────────
    // Overview tab is active by default
    await expect(page.getByRole('link', { name: 'Overview' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Artifacts' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Gates' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Audit' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Delivery' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Progress' })).toBeVisible();

    // Navigate to Artifacts tab
    await page.getByRole('link', { name: 'Artifacts' }).click();
    await page.waitForURL('**/runs/run_1/artifacts');

    // Navigate to Gates tab
    await page.getByRole('link', { name: 'Gates' }).click();
    await page.waitForURL('**/runs/run_1/gates');

    // Navigate to Audit tab
    await page.getByRole('link', { name: 'Audit' }).click();
    await page.waitForURL('**/runs/run_1/audit');

    // Navigate to Delivery tab
    await page.getByRole('link', { name: 'Delivery' }).click();
    await page.waitForURL('**/runs/run_1/delivery');
    await expect(
      page.getByText('交付管道 Delivery Pipeline'),
    ).toBeVisible();

    // Navigate to Progress tab
    await page.getByRole('link', { name: 'Progress' }).click();
    await page.waitForURL('**/runs/run_1/progress');

    // ── 5. URL persists on refresh (runId + tab) ──────────────────────────
    await page.getByRole('link', { name: 'Gates' }).click();
    await page.waitForURL('**/runs/run_1/gates');

    await page.reload();
    await page.waitForURL('**/runs/run_1/gates');
    // After reload we're still on the gates tab of run_1
    await expect(page.locator('.run-header-id')).toHaveText('run_1');

    // ── 6. Approvals page loads at /approvals ─────────────────────────────
    await page.getByRole('link', { name: '审批队列' }).click();
    await page.waitForURL('**/approvals');

    await expect(
      page.getByRole('heading', { name: 'Approvals' }),
    ).toBeVisible();

    // Pending decision is displayed
    await expect(page.getByText('decision_1', { exact: true })).toBeVisible();

    // ── 7. Approve without token → expect error flash ─────────────────────
    // Token is not set (auth starts with null token).
    // The token-warning banner is shown.
    await expect(
      page.getByText('需要提供 token 才能执行审批操作'),
    ).toBeVisible();

    // The approve button uses two-step confirmation:
    // First click → "确认批准?", second click → executes.
    // Without a token the handler fires a flash error.
    await page.getByRole('button', { name: '✓ Approve' }).click();
    // Wait for the confirmation state
    await expect(
      page.getByRole('button', { name: '确认批准?' }),
    ).toBeVisible();
    // Second click triggers the handler which checks token
    await page.getByRole('button', { name: '确认批准?' }).click();

    // Flash error message appears
    await expect(
      page.getByText('请先登录并提供 token'),
    ).toBeVisible();
  });
});
