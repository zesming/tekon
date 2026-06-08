import { expect, test } from '@playwright/test';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

test.describe('Donkey dashboard', () => {
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

  test('shows core dashboard sections and approves a pending human gate', async ({
    page,
  }) => {
    await page.goto(server.url);

    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '工作流操作' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '产物' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Gates' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '审计' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '角色' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '工作流', exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(
      page.getByRole('heading', { name: '待人工审批' }),
    ).toBeVisible();
    await expect(page.getByText('decision_1')).toBeVisible();
    await expect(page.getByText('risk: high', { exact: true })).toBeVisible();
    await expect(
      page.getByText('donkey run --template standard-feature --agent mock', {
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.getByText('Hash chain: valid')).toBeVisible();

    await page.getByLabel('Audit node filter').fill('node_1');
    await page.getByLabel('Audit gate filter').fill('gate_1');
    await page.getByLabel('Audit role filter').fill('reviewer');
    await page.getByRole('button', { name: '筛选审计' }).click();
    await expect(page.getByText('human.decision.pending node_1')).toBeVisible();

    await page.getByLabel('Session token').fill(fixture.sessionToken);
    await page.getByLabel('审批备注').fill('approved from dashboard');
    await page.getByRole('button', { name: '批准', exact: true }).click();

    await expect(page.getByText('approved')).toBeVisible();
    await expect(page.getByText('run_1', { exact: true })).toBeVisible();
  });
});
