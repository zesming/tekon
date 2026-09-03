import { test, expect } from './shared-fixture.js';

// Advanced Run admission and single-submit latch regression suite.
// Covers:
// 1. Empty demand initial state disables button without active alert;
// 2. Concurrent double-click single-submit latch protection;
// 3. Mutation failure release (failed first attempt displays error and frees latch for retry);
// 4. Draft with unapproved plan (approved=true, readyForRun=true, hasPlan=true, planApproved=false)
//    must keep button disabled and display unapproved plan warning.

test.describe('Advanced Run Admission & Single Submit', () => {
  test('empty demand initially keeps submit button disabled without warning, enables after filling', async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/advanced/runs`);
    const disclosure = page.getByRole('button', { name: '✦ 新建运行' });
    await disclosure.click();
    await expect(page.locator('#start-run-form-body')).toBeVisible();

    const demandInput = page.getByLabel('需求描述', { exact: true });
    const submitButton = page.getByRole('button', { name: '▶ 发起运行' });

    // Initial empty demand: button must be disabled, no warning banner actively rendered
    await expect(demandInput).toHaveValue('');
    await expect(submitButton).toBeDisabled();
    await expect(page.getByRole('alert')).toHaveCount(0);

    // Filling demand text enables submit button
    await demandInput.fill('准入测试有效需求');
    await expect(submitButton).toBeEnabled();

    // Clearing demand disables submit button again
    await demandInput.fill('');
    await expect(submitButton).toBeDisabled();
  });

  test('single-submit: blocks duplicate concurrent submission via latch when double-clicked', async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/advanced/runs`);
    const disclosure = page.getByRole('button', { name: '✦ 新建运行' });
    await disclosure.click();
    await expect(page.locator('#start-run-form-body')).toBeVisible();

    const demandInput = page.getByLabel('需求描述', { exact: true });
    await demandInput.fill('单次提交防重验证需求');

    const submitButton = page.getByRole('button', { name: '▶ 发起运行' });
    await expect(submitButton).toBeEnabled();

    let projectRunCount = 0;
    await page.route('**/api/rpc', async (route) => {
      const request = route.request();
      let isProjectRun = false;
      try {
        const postData = request.postDataJSON();
        isProjectRun = postData?.path === 'project.run';
      } catch {
        isProjectRun = false;
      }

      if (isProjectRun) {
        projectRunCount++;
        if (projectRunCount === 1) {
          // Delay first project.run response so first request stays in-flight during second click
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
      await route.continue();
    });

    // Synchronously dispatch two clicks inside the page, explicitly removing the DOM
    // disabled attribute after the first click to simulate programmatic bypass.
    await submitButton.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.removeAttribute('disabled');
      button.disabled = false;
      button.click();
    });

    // Wait for the in-flight project.run RPC to settle
    await page.waitForResponse(
      (res) => {
        if (!res.url().includes('/api/rpc') || res.status() !== 200) {
          return false;
        }
        try {
          return res.request().postDataJSON()?.path === 'project.run';
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    );

    // Final assertion: must only dispatch exactly 1 project.run request
    expect(projectRunCount).toBe(1);
  });

  test('mutation failure release: failed first attempt displays error and frees latch, subsequent attempt succeeds', async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/advanced/runs`);
    const disclosure = page.getByRole('button', { name: '✦ 新建运行' });
    await disclosure.click();
    await expect(page.locator('#start-run-form-body')).toBeVisible();

    const demandInput = page.getByLabel('需求描述', { exact: true });
    await demandInput.fill('首次失败重试需求');

    const submitButton = page.getByRole('button', { name: '▶ 发起运行' });
    await expect(submitButton).toBeEnabled();

    let projectRunCount = 0;
    await page.route('**/api/rpc', async (route) => {
      const request = route.request();
      let isProjectRun = false;
      try {
        const postData = request.postDataJSON();
        isProjectRun = postData?.path === 'project.run';
      } catch {
        isProjectRun = false;
      }

      if (isProjectRun) {
        projectRunCount++;
        if (projectRunCount === 1) {
          // Fail the first project.run with a non-2xx parsable JSON error
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({
              error: {
                code: 'INTERNAL_ERROR',
                message: '模拟服务端执行异常',
              },
            }),
          });
          return;
        }
      }

      await route.continue();
    });

    // First submit fails
    await submitButton.click();
    await expect(page.getByText('模拟服务端执行异常').first()).toBeVisible();
    await expect(submitButton).toBeEnabled();

    // Second submit succeeds
    const secondResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/rpc') &&
        res.status() === 200 &&
        res.request().postDataJSON()?.path === 'project.run',
      { timeout: 15_000 },
    );
    await submitButton.click();
    const secondResponse = await secondResponsePromise;
    const body = await secondResponse.json();
    expect(body.result?.run?.id).toBeTruthy();
    expect(body.error).toBeUndefined();

    // Exactly two project.run RPC requests were dispatched
    expect(projectRunCount).toBe(2);
  });

  test('draft with unapproved plan keeps submit button disabled and shows unapproved plan warning', async ({
    page,
    server,
  }) => {
    const mockShape = {
      schemaVersion: 1,
      id: 'shape-unapproved-plan',
      rawText: '包含未批准计划的需求草案',
      title: '未批准计划需求',
      summary: '概要',
      category: 'feature',
      recommendedTemplate: 'project-feature',
      risk: {
        level: 'low',
        tags: [],
        requiresHumanApproval: false,
        reasons: [],
      },
      nonGoals: [],
      assumptions: [],
      openQuestions: [],
      acceptanceCriteria: [
        {
          id: 'ac-1',
          description: '验收标准',
          verificationMethod: 'unit',
          passCriteria: '全部通过',
        },
      ],
      readyForRun: true,
      approved: true,
      approvedBy: 'tester',
      approvedAt: new Date().toISOString(),
      hasPlan: true,
      planApproved: false,
      createdAt: new Date().toISOString(),
    };

    await page.route('**/api/rpc', async (route) => {
      const request = route.request();
      let isDraftDetail = false;
      try {
        const postData = request.postDataJSON();
        isDraftDetail = postData?.path === 'draftShape.detail';
      } catch {
        isDraftDetail = false;
      }

      if (isDraftDetail) {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            result: {
              shape: mockShape,
            },
          }),
        });
        return;
      }

      await route.continue();
    });

    await page.goto(
      `${server.url}/advanced/runs?shapePath=.tekon/drafts/unapproved-plan.json`,
    );

    // Form expands automatically on demand prefill
    await expect(page.locator('#start-run-form-body')).toBeVisible();
    await expect(page.getByLabel('需求描述', { exact: true })).toHaveValue(
      '包含未批准计划的需求草案',
    );

    // Verify execution plan preview is loaded and healthy (neither loading nor error)
    await expect(
      page.getByRole('region', { name: '执行计划预览' }),
    ).toBeVisible();
    await expect(page.getByText('无法读取执行计划')).toHaveCount(0);

    const submitButton = page.getByRole('button', { name: '▶ 发起运行' });
    // Regression check: must be disabled because draft plan is unapproved (hasPlan=true && planApproved=false)
    await expect(submitButton).toBeDisabled({ timeout: 3000 });
    // Regression check: must display the unapproved plan warning
    await expect(page.getByText(/计划未批准/)).toBeVisible({ timeout: 3000 });
  });

  test('mobile widths: keep run options in one column without overflow and use concise option labels', async ({
    page,
    server,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${server.url}/advanced/runs`);

    const disclosure = page.getByRole('button', { name: '✦ 新建运行' });
    await disclosure.click();
    await expect(page.locator('#start-run-form-body')).toBeVisible();

    const expectNoHorizontalOverflow = async () => {
      const widths = await page.evaluate(() => ({
        viewport: window.innerWidth,
        document: document.documentElement.scrollWidth,
        body: document.body.scrollWidth,
      }));
      expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
      expect(widths.body).toBeLessThanOrEqual(widths.viewport + 1);
    };

    await expectNoHorizontalOverflow();

    const planPreview = page.getByRole('region', { name: '执行计划预览' });
    await expect(planPreview).toBeVisible();
    await expect(planPreview).toContainText('角色链路');
    await expect(page.getByText('无法读取执行计划')).toHaveCount(0);

    const modeSelect = page.locator('#start-run-mode');
    const templateSelect = page.locator('#start-run-template');
    const agentSelect = page.locator('#start-run-agent');
    const profileSelect = page.locator('#start-run-profile');

    const selects = [modeSelect, templateSelect, agentSelect, profileSelect];
    for (const select of selects) {
      await expect(select).toBeVisible();
    }

    const expectSelectsInSingleColumn = async () => {
      const boxes = await Promise.all(
        selects.map(async (select) => {
          const box = await select.boundingBox();
          expect(box).toBeTruthy();
          return box!;
        }),
      );

      // 同x / 近似同宽
      const firstBox = boxes[0];
      for (let i = 1; i < boxes.length; i++) {
        expect(Math.abs(boxes[i].x - firstBox.x)).toBeLessThanOrEqual(2);
        expect(Math.abs(boxes[i].width - firstBox.width)).toBeLessThanOrEqual(
          2,
        );
      }

      // 后一项top >= 前一项bottom
      for (let i = 1; i < boxes.length; i++) {
        const prevBottom = boxes[i - 1].y + boxes[i - 1].height;
        expect(boxes[i].y).toBeGreaterThanOrEqual(prevBottom - 1);
      }
    };

    await expectSelectsInSingleColumn();

    // 选择mock后断言selected option文本为“mock（仅测试/演示）”且提示note完整
    await agentSelect.selectOption('mock');
    const selectedOptionText = await agentSelect.evaluate(
      (el: HTMLSelectElement) => el.options[el.selectedIndex]?.text.trim(),
    );
    expect(selectedOptionText).toBe('mock（仅测试/演示）');

    const mockNote = page.getByRole('note');
    await expect(mockNote).toBeVisible();
    await expect(mockNote).toHaveText(
      'mock 仅用于测试或演示：它会生成合成结果与产物，不会执行真实代理任务，也不能作为交付完成证据。',
    );

    await agentSelect.selectOption('dsh-headless');
    const selectedDshOptionText = await agentSelect.evaluate(
      (el: HTMLSelectElement) => el.options[el.selectedIndex]?.text.trim(),
    );
    expect(selectedDshOptionText).toBe(
      'dsh-headless（experimental · 仅 Goal）',
    );
    await expect(modeSelect).toHaveValue('goal');
    await expect(page.locator('#run-mode-help')).toContainText(
      '网络访问不受 Tekon 限制',
    );
    await expect(page.getByRole('alert')).toContainText('联网不受限');

    await modeSelect.selectOption('workflow');
    await expect(agentSelect).toHaveValue('codex');
    await expect(profileSelect).toBeEnabled();
    await profileSelect.selectOption('autonomous-delivery');
    const selectedProfileOptionText = await profileSelect.evaluate(
      (el: HTMLSelectElement) => el.options[el.selectedIndex]?.text.trim(),
    );
    expect(selectedProfileOptionText).toBe('autonomous-delivery（自动准备）');

    const profileHelp = page.locator(
      '#start-run-profile + #start-run-profile-help',
    );
    await expect(profileHelp).toBeVisible();
    await expect(profileHelp).toHaveText(
      '运行通过后自动准备交付证据，不会自动创建 PR。',
    );
    await expect(profileSelect).toHaveAttribute(
      'aria-describedby',
      'start-run-profile-help',
    );

    await modeSelect.selectOption('goal');
    await expect(profileSelect).toBeDisabled();
    await expect(profileSelect).toHaveValue('human-web');
    await expect(page.locator('#start-run-profile-help')).toHaveCount(0);

    await page.setViewportSize({ width: 700, height: 900 });
    await expectSelectsInSingleColumn();
    await expectNoHorizontalOverflow();
  });
});
