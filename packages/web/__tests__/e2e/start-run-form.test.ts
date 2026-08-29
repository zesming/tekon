import { test, expect } from './shared-fixture.js';

// P2-TEST-01: dedicated browser assertions for the advanced StartRunForm
// Goal/dsh state toggle. The form lives at /advanced/runs and its mode/agent
//联动 is pure client-side state — no real run is started.

test('StartRunForm Goal/dsh mode toggle disables incompatible fields', async ({
  page,
  server,
}) => {
  await page.goto(`${server.url}/advanced/runs`);
  await expect(
    page.getByRole('heading', { name: '运行管理 Runs' }),
  ).toBeVisible();

  // Expand the "New Run" form.
  await page.getByText('✦ 新建运行').click();
  await expect(page.getByLabel('描述你的需求')).toBeVisible();

  // Locate the four selects by their form-group label text.
  const modeSelect = page
    .locator('.form-group', { hasText: '运行模式' })
    .locator('select');
  const templateSelect = page
    .locator('.form-group', { hasText: '工作流模板' })
    .locator('select');
  const agentSelect = page
    .locator('.form-group', { hasText: '执行代理' })
    .locator('select');
  const profileSelect = page
    .locator('.form-group', { hasText: 'Profile' })
    .locator('select');
  const helpText = page.locator('#run-mode-help');

  // Default: workflow + codex, all fields enabled.
  await expect(modeSelect).toHaveValue('workflow');
  await expect(agentSelect).toHaveValue('codex');
  await expect(templateSelect).toBeEnabled();
  await expect(profileSelect).toBeEnabled();

  // (a) Selecting dsh-headless auto-switches to Goal and disables
  // template + profile; help text explains the constraint.
  await agentSelect.selectOption('dsh-headless');
  await expect(modeSelect).toHaveValue('goal');
  await expect(templateSelect).toBeDisabled();
  await expect(profileSelect).toBeDisabled();
  await expect(helpText).toContainText('dsh-headless 仅可在此模式使用');

  // (b) Switching back to Workflow reverts agent to codex and re-enables
  // template + profile.
  await modeSelect.selectOption('workflow');
  await expect(agentSelect).toHaveValue('codex');
  await expect(templateSelect).toBeEnabled();
  await expect(profileSelect).toBeEnabled();
  await expect(helpText).toContainText('dsh-headless 不支持此模式');

  // (c) Direct Goal switch (with a non-dsh agent) disables template +
  // profile but keeps the agent unchanged.
  await agentSelect.selectOption('claude-code');
  await modeSelect.selectOption('goal');
  await expect(agentSelect).toHaveValue('claude-code');
  await expect(templateSelect).toBeDisabled();
  await expect(profileSelect).toBeDisabled();
});
