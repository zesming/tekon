import { test, expect } from './shared-fixture.js';

// P2-TEST-01 / T2 / T7: dedicated browser assertions for the advanced
// StartRunForm Goal/dsh state linkage, execution plan preview, unrestricted network
// acknowledgement, and accessible disclosure semantics. The form lives at /advanced/runs.

test('StartRunForm exposes keyboard disclosure, renders execution plan preview, and enforces unrestricted network acknowledgement', async ({
  page,
  server,
}) => {
  await page.goto(`${server.url}/advanced/runs`);
  await expect(
    page.getByRole('heading', { name: '运行管理 Runs' }),
  ).toBeVisible();

  const disclosure = page.getByRole('button', { name: '✦ 新建运行' });
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(disclosure).toHaveAttribute(
    'aria-controls',
    'start-run-form-body',
  );

  // Keyboard users can expand the form and every visible field is reachable by
  // its real accessible label rather than a CSS/text-structure locator.
  await disclosure.focus();
  await page.keyboard.press('Enter');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#start-run-form-body')).toBeVisible();
  await expect(page.getByLabel('需求描述', { exact: true })).toBeVisible();

  const modeSelect = page.getByLabel('运行模式', { exact: true });
  const templateSelect = page.getByLabel('工作流模板', { exact: true });
  const agentSelect = page.getByLabel('执行代理', { exact: true });
  const profileSelect = page.getByLabel('Profile', { exact: true });
  const helpText = page.locator('#run-mode-help');
  const submitButton = page.getByRole('button', { name: '▶ 发起运行' });

  // Default: workflow + codex, all compatible fields enabled.
  await expect(modeSelect).toHaveValue('workflow');
  await expect(agentSelect).toHaveValue('codex');
  await expect(templateSelect).toBeEnabled();
  await expect(profileSelect).toBeEnabled();

  // T2: Plan preview distinguishes a plan declaration from host enforcement.
  const planPreview = page.getByRole('region', { name: '执行计划预览' });
  await expect(planPreview).toBeVisible();
  await expect(planPreview).toContainText('角色链路');
  await expect(planPreview).toContainText('计划未请求不受限网络');
  await expect(planPreview).toContainText(
    '实际网络隔离仍取决于 Provider 与宿主环境',
  );
  await expect(planPreview).not.toContainText('网络受控隔离');

  // Fill in demand text
  const demandInput = page.getByLabel('需求描述', { exact: true });
  await demandInput.fill('测试需求描述');
  await expect(submitButton).toBeEnabled();

  // The production form may expose mock for offline demos, but it must make the
  // synthetic/no-real-execution boundary explicit before a user can mistake it
  // for delivery evidence.
  await agentSelect.selectOption('mock');
  await expect(page.getByRole('note')).toContainText(
    '生成合成结果与产物，不会执行真实代理任务',
  );

  // (a) Selecting dsh-headless auto-switches to Goal and disables
  // template + profile; help text explains the constraint.
  await agentSelect.selectOption('dsh-headless');
  await expect(modeSelect).toHaveValue('goal');
  await expect(templateSelect).toBeDisabled();
  await expect(profileSelect).toBeDisabled();
  await expect(helpText).toContainText('dsh-headless 仅可在此模式使用');

  // T2: Unrestricted network warning appears and submit button is blocked until acknowledged
  const networkAlert = page.getByRole('alert');
  await expect(networkAlert).toBeVisible();
  await expect(networkAlert).toContainText('联网不受限');

  const ackCheckbox = page.getByLabel('我已知悉本次运行联网不受限');
  await expect(ackCheckbox).toBeVisible();
  await expect(ackCheckbox).not.toBeChecked();

  // Submit button is disabled while unrestricted network is unacknowledged
  await expect(submitButton).toBeDisabled();

  // Checking the box enables the submit button
  await ackCheckbox.check();
  await expect(ackCheckbox).toBeChecked();
  await expect(submitButton).toBeEnabled();

  // Unchecking disables it again
  await ackCheckbox.uncheck();
  await expect(submitButton).toBeDisabled();

  // (b) Switching back to Workflow reverts agent to codex and re-enables
  // template + profile. Network alert clears and submit button is enabled again.
  await modeSelect.selectOption('workflow');
  await expect(agentSelect).toHaveValue('codex');
  await expect(templateSelect).toBeEnabled();
  await expect(profileSelect).toBeEnabled();
  await expect(helpText).toContainText('dsh-headless 不支持此模式');
  await expect(networkAlert).not.toBeVisible();
  await expect(submitButton).toBeEnabled();

  // (c) Direct Goal switch (with a non-dsh agent) disables template + profile
  // but keeps the selected agent unchanged.
  await agentSelect.selectOption('claude-code');
  await modeSelect.selectOption('goal');
  await expect(agentSelect).toHaveValue('claude-code');
  await expect(templateSelect).toBeDisabled();
  await expect(profileSelect).toBeDisabled();
  await expect(submitButton).toBeEnabled();

  // Space activates the same native disclosure control and its state remains
  // exposed to assistive technology.
  await disclosure.focus();
  await page.keyboard.press('Space');
  await expect(disclosure).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#start-run-form-body')).toBeHidden();
});

// B1 regression: the plan-preview digest input domain must match the
// project.run submission domain. Previously the preview sent profile
// unconditionally while submission omitted the default 'human-web', so the
// server recomputed a different digest and rejected every default workflow
// run with PLAN_DIGEST_MISMATCH. This test drives the real form submit path.
test('StartRunForm default workflow run submits with a matching plan digest', async ({
  page,
  server,
}) => {
  await page.goto(`${server.url}/advanced/runs`);
  await page.getByRole('button', { name: '✦ 新建运行' }).click();
  await expect(page.locator('#start-run-form-body')).toBeVisible();

  await page.getByLabel('需求描述', { exact: true }).fill('B1 digest 对称验证');

  // Default mode=workflow, agent=codex, profile=human-web.
  const submitButton = page.getByRole('button', { name: '▶ 发起运行' });
  await expect(submitButton).toBeEnabled();

  // The run must be accepted — no digest mismatch rejection. Assert on the
  // RPC response itself (the success toast auto-dismisses).
  const runResponse = page.waitForResponse(
    (res) =>
      res.url().includes('/api/rpc') &&
      res.status() === 200 &&
      res.request().postDataJSON()?.path === 'project.run',
    { timeout: 15000 },
  );
  await submitButton.click();
  const response = await runResponse;
  const body = await response.json();
  expect(body.result?.run?.id).toBeTruthy();
  expect(body.error).toBeUndefined();
  await expect(page.getByText('PLAN_DIGEST_MISMATCH')).toHaveCount(0);
});
