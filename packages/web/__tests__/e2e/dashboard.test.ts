import { expect, test } from './shared-fixture.js';

test.describe('Tekon main flow', () => {
  test('dashboard, run list, run detail tabs, approvals, and authenticated operations', async ({
    page,
    server,
    fixture,
  }) => {
    // ── 1. Dashboard page loads with sidebar ──────────────────────────────
    // Phase 3 3d: the legacy Cockpit dashboard moved to /advanced (the default
    // route `/` is now the human-first Session UI).
    await page.goto(`${server.url}/advanced`);

    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
    await expect(page.getByText('Tekon', { exact: true })).toBeVisible();
    await expect(page.getByText('Cockpit', { exact: true })).toBeVisible();

    // Shared business journeys use the production sessionStorage bootstrap,
    // so the visible UI credential and the RPC/SSE credential are the same.
    await expect(
      page.getByRole('button', { name: '连接凭据：已设置' }),
    ).toBeVisible();

    // Sidebar navigation items are present
    await expect(page.getByRole('link', { name: '高级 Advanced' })).toBeVisible();
    await expect(page.getByRole('link', { name: '运行列表' })).toBeVisible();
    await expect(page.getByRole('link', { name: '审批队列' })).toBeVisible();

    // Dashboard stat cards render
    await expect(page.getByText('运行 Runs')).toBeVisible();
    await expect(page.getByText('通过率 Pass Rate')).toBeVisible();

    // ── 2. Navigate to /advanced/runs → run list renders ──────────────────
    await page.getByRole('link', { name: '运行列表' }).click();
    await page.waitForURL('**/advanced/runs');

    await expect(
      page.getByRole('heading', { name: '运行管理 Runs' }),
    ).toBeVisible();

    // Both fixture runs appear in the table
    await expect(page.getByText('run_1', { exact: true })).toBeVisible();
    await expect(page.getByText('run_0', { exact: true })).toBeVisible();

    // ── 3. Click a run → navigate to /advanced/runs/:runId ────────────────
    await page.getByText('run_1', { exact: true }).click();
    await page.waitForURL('**/advanced/runs/run_1');

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

    // ── 7. Configured credential exposes approval controls ────────────────
    await expect(
      page.getByText('需要提供 token 才能执行审批操作'),
    ).not.toBeVisible();
    await expect(page.getByRole('button', { name: '✓ 批准' })).toBeEnabled();
  });
});
