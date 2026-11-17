import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { defaultBuiltInRolesDir } from '@tekon/core';

import { expect, test } from './shared-fixture.js';

test.describe('Config, Eval, and Demand pages', () => {
  // ── Config page ────────────────────────────────────────────────────────

  test('config page loads with Roles and Workflows tabs (Constraints removed)', async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/advanced/config`);

    await expect(page.getByText('Config', { exact: true })).toBeVisible();

    // Tab navigation links: Constraints tab was removed by PD-11.
    await expect(page.getByRole('link', { name: 'Roles' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Workflows' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Constraints' })).toHaveCount(
      0,
    );

    // Default tab: Roles — fixture RD role is visible as a project override.
    await expect(page.getByText('rd', { exact: true })).toBeVisible();
    await expect(page.getByText('项目 project').first()).toBeVisible();

    // Navigate to Workflows tab.
    await page.getByRole('link', { name: 'Workflows' }).click();
    await page.waitForURL('**/config/workflows');
    await expect(
      page.getByText('project-feature', { exact: true }),
    ).toBeVisible();

    // The old Constraints URL now renders the SPA not-found page.
    await page.goto(`${server.url}/advanced/config/constraints`);
    await expect(page.getByText('页面不存在')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Constraints' })).toHaveCount(
      0,
    );
  });

  test('edits a built-in role prompt and persists a project override', async ({
    page,
    server,
    fixture,
  }) => {
    await page.goto(`${server.url}/advanced/config`);

    // Open the built-in pm role detail panel.
    const pmRow = page.locator('tr', { hasText: 'pm' }).first();
    await pmRow.getByRole('button', { name: '查看 / 编辑' }).click();

    const promptBox = page.getByLabel('pm 系统提示词');
    await expect(promptBox).toBeVisible();
    const builtInPrompt = await promptBox.inputValue();
    expect(builtInPrompt.length).toBeGreaterThan(0);

    // Switch to edit mode and save a new prompt.
    await page.getByRole('button', { name: '编辑 prompt' }).click();
    await promptBox.fill('端到端测试写入的 PM 自定义提示词');
    await page.getByRole('button', { name: '保存覆盖' }).click();

    await expect(page.getByText('已保存项目级角色覆盖')).toBeVisible();

    // The file landed in the fixture project as a whole-folder override.
    const projectRoleDir = join(fixture.projectRoot, '.tekon', 'roles', 'pm');
    await expect
      .poll(() => existsSync(join(projectRoleDir, 'agent.yaml')))
      .toBe(true);
    expect(readFileSync(join(projectRoleDir, 'system.md'), 'utf8')).toBe(
      '端到端测试写入的 PM 自定义提示词',
    );

    // The built-in installation folder is untouched.
    const builtInSystemMd = join(defaultBuiltInRolesDir(), 'pm', 'system.md');
    expect(readFileSync(builtInSystemMd, 'utf8')).toBe(builtInPrompt);

    // Reopening the panel shows the persisted project prompt.
    await page.getByRole('button', { name: '关闭角色详情' }).click();
    await pmRow.getByRole('button', { name: '查看 / 编辑' }).click();
    await expect(promptBox).toHaveValue('端到端测试写入的 PM 自定义提示词');
  });

  // ── Eval page ──────────────────────────────────────────────────────────

  test('eval page loads with Readiness, Demand Shape, Approval Summary, and Workflow Selection tabs', async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/advanced/eval`);

    await expect(page.getByText('Evaluations', { exact: true })).toBeVisible();

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
    await page.goto(`${server.url}/advanced/demand`);

    // The demand entry point renders the clarification (需求澄清) page.
    // (UI was localized to Chinese; the title is no longer "Demand".)
    await expect(page.locator('.page-title')).toContainText('需求澄清');
  });
});
