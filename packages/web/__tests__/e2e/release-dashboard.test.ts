import { expect, test } from '@playwright/test';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

test.describe('Tekon release dashboard', () => {
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

  test('reviews release dashboard sections and writes human approval', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(server.url);

    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '工作流操作' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '待人工审批' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '产物' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Gates' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Readiness' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Diff' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Evidence Links' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Gate Failure Triage' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Artifact 正文' }),
    ).toBeVisible();
    await expect(
      page.getByRole('heading', { name: 'Gate Logs' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'PR 包' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '下一步' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '审计' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '角色' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '工作流', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(page.getByText('risk: high', { exact: true })).toBeVisible();
    await expect(page.getByLabel('审批摘要')).toContainText('Tekon 审批摘要');
    await expect(page.getByLabel('审批摘要')).toContainText(
      'tekon approval reject',
    );
    await expect(page.getByText('Hash chain: valid')).toBeVisible();
    await expect(page.getByText('Review report body')).toBeVisible();
    await expect(
      page.getByText('human approval is required', { exact: true }),
    ).toBeVisible();
    await expect(page.getByText('human human-approval')).toBeVisible();
    await expect(page.getByText(/retry=after-approval/u)).toBeVisible();
    await expect(
      page.getByText('command=tekon resume --run-id run_1 --approve-human'),
    ).toBeVisible();
    await expect(page.getByText('Review Route info')).toBeVisible();
    await expect(page.getByLabel('Review run')).toContainText('run_0');
    await expect(page.getByLabel('Run template')).toContainText(
      'test-improvement',
    );
    await expect(page.getByLabel('Run template')).toContainText('docs-update');
    await expect(page.getByLabel('Run template')).toContainText('plan-only');

    await page.getByLabel('Review run').selectOption('run_0');
    await expect(page.getByText('Older run review body')).toBeVisible();
    await expect(page.getByText('older build passed')).toBeVisible();

    await page.getByLabel('Review run').selectOption('run_1');
    await expect(page.getByText('Review report body')).toBeVisible();
    await page.getByLabel('Action token').fill(fixture.sessionToken);
    await page.getByRole('button', { name: '准备 PR' }).click();
    await expect(
      page.getByText('PR prepared: tekon-delivery/run_1 -> main'),
    ).toBeVisible();

    await page.getByLabel('Session token').fill(fixture.sessionToken);
    await page.getByLabel('审批备注').fill('release approval');
    await page.getByRole('button', { name: '批准', exact: true }).click();

    await expect(page.getByText('approved', { exact: true })).toBeVisible();
    await expect(page.getByText('gate_1 passed')).toBeVisible();

    await page
      .getByLabel('Run demand')
      .fill('Web starts a controlled mock run from the dashboard.');
    await page.getByRole('button', { name: '塑形需求' }).click();
    await expect(page.getByText(/demand shaped:/u)).toBeVisible();
    await expect(page.getByText(/openQuestions=/u)).toBeVisible();
    await page.getByRole('button', { name: '批准需求' }).click();
    await expect(page.getByText(/demand approved:/u)).toBeVisible();
    await page.getByRole('button', { name: '发起运行' }).click();
    await expect(page.getByText(/run started:/u)).toBeVisible();
    await page.getByRole('button', { name: '准备 PR' }).click();
    await expect(page.getByText(/PR prepared:/u)).toBeVisible();
    await expect(
      page.getByRole('button', { name: '批准并创建 PR' }),
    ).toBeVisible();

    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath('tekon-dashboard-mobile.png'),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath('tekon-dashboard-desktop.png'),
    });
  });
});
