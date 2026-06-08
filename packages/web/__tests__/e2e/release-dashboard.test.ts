import { expect, test } from '@playwright/test';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

test.describe('Donkey release dashboard', () => {
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
      page.getByRole('heading', { name: '待人工审批' }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: '产物' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Gates' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '审计' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '角色' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '工作流' })).toBeVisible();
    await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();
    await expect(page.getByText('risk: high', { exact: true })).toBeVisible();
    await expect(page.getByText('Hash chain: valid')).toBeVisible();

    await page.getByLabel('Session token').fill(fixture.sessionToken);
    await page.getByLabel('审批备注').fill('release approval');
    await page.getByRole('button', { name: '批准' }).click();

    await expect(page.getByText('approved', { exact: true })).toBeVisible();
    await expect(page.getByText('gate_1 passed')).toBeVisible();

    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath('donkey-dashboard-mobile.png'),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(page.getByRole('heading', { name: '概览' })).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath('donkey-dashboard-desktop.png'),
    });
  });
});
