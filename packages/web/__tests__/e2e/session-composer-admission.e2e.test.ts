import { test, expect } from './shared-fixture.js';
import { credentialStatus } from './helpers/locators.js';

test.describe('Session Composer Admission & Single Submit', () => {
  test('default Session composer synchronously blocks duplicate Run creation', async ({
    page,
    server,
  }) => {
    await page.goto(server.url);

    const demandInput = page.getByLabel('新建受控交付任务');
    const submitButton = page.getByRole('button', { name: '启动受控交付' });
    await demandInput.fill('默认入口同步单飞验证');
    await expect(submitButton).toBeEnabled();

    let projectRunCount = 0;
    await page.route('**/api/rpc', async (route) => {
      let isProjectRun = false;
      try {
        isProjectRun = route.request().postDataJSON()?.path === 'project.run';
      } catch {
        isProjectRun = false;
      }

      if (isProjectRun) {
        projectRunCount += 1;
        if (projectRunCount === 1) {
          // Keep the first call open across the second same-turn activation.
          await new Promise((resolve) => setTimeout(resolve, 800));
        }
      }
      await route.continue();
    });

    const responsePromise = page.waitForResponse(
      (response) => {
        if (!response.url().includes('/api/rpc') || response.status() !== 200) {
          return false;
        }
        try {
          return response.request().postDataJSON()?.path === 'project.run';
        } catch {
          return false;
        }
      },
      { timeout: 15_000 },
    );

    // Bypass the DOM disabled state after the first activation to prove the
    // component's synchronous latch, not React rendering speed, owns single-flight.
    await submitButton.evaluate((button: HTMLButtonElement) => {
      button.click();
      button.removeAttribute('disabled');
      button.disabled = false;
      button.click();
    });

    await responsePromise;
    expect(projectRunCount).toBe(1);
  });

  test('releases submission latch on project.run failure and succeeds on subsequent retry', async ({
    page,
    server,
  }) => {
    await page.goto(server.url);
    await expect(credentialStatus(page, 'valid')).toBeVisible({
      timeout: 15_000,
    });

    const demandInput = page.getByLabel('新建受控交付任务');
    const submitButton = page.getByRole('button', { name: '启动受控交付' });
    await demandInput.fill('首次失败重试需求');
    await expect(submitButton).toBeEnabled();

    let projectRunCount = 0;
    await page.route('**/api/rpc', async (route) => {
      let isProjectRun = false;
      try {
        isProjectRun = route.request().postDataJSON()?.path === 'project.run';
      } catch {
        isProjectRun = false;
      }

      if (isProjectRun) {
        projectRunCount += 1;
        if (projectRunCount === 1) {
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

    // First submit fails with 500 error
    await submitButton.click();
    await expect(page.getByText('模拟服务端执行异常')).toBeVisible();
    // Latch must be released in finally block, re-enabling submit button
    await expect(submitButton).toBeEnabled();

    // Second submit succeeds and navigates to session detail
    const secondResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/rpc') &&
        res.status() === 200 &&
        res.request().postDataJSON()?.path === 'project.run',
      { timeout: 15_000 },
    );
    await submitButton.click();
    const secondResponse = await secondResponsePromise;
    const body = (await secondResponse.json()) as {
      result?: { sessionId?: string; run?: { id: string } };
      error?: unknown;
    };
    expect(body.result?.sessionId).toBeTruthy();
    expect(body.error).toBeUndefined();

    // Verify navigation to session detail route
    await expect(page).toHaveURL(
      new RegExp(`/sessions/${body.result!.sessionId}`),
    );
    expect(projectRunCount).toBe(2);
  });

  test('renders retry button when plan digest is missing and recovers on retry', async ({
    page,
    server,
  }) => {
    let planRequestCount = 0;
    let retryClicked = false;
    await page.route('**/api/rpc', async (route) => {
      let isWorkflowPlan = false;
      try {
        isWorkflowPlan =
          route.request().postDataJSON()?.path === 'workflow.plan';
      } catch {
        isWorkflowPlan = false;
      }

      if (isWorkflowPlan) {
        planRequestCount += 1;
        // 重试前的所有计划请求都返回缺摘要计划。PD-08 后 agent 从空串初始化为
        // 默认代理会以不同 planKey 再发一次请求，必须让每个 key 都命中阻断态，
        // 否则后到的有效计划会掩盖缺摘要错误；点击重试后才放行真实计划。
        if (!retryClicked) {
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              result: {
                roleChain: ['analyst', 'executor'],
                gates: [],
                phases: [],
                requiresUnrestrictedNetwork: false,
                digest: '',
              },
            }),
          });
          return;
        }
      }
      await route.continue();
    });

    // Fresh navigation with route handler installed to intercept initial workflow.plan
    await page.goto(`${server.url}/?fresh=plan-retry`);
    await expect(credentialStatus(page, 'valid')).toBeVisible({
      timeout: 15_000,
    });

    const demandInput = page.getByLabel('新建受控交付任务');
    const submitButton = page.getByRole('button', { name: '启动受控交付' });
    await demandInput.fill('测试缺少摘要重试需求');

    const planRegion = page.getByRole('region', { name: '执行前计划' });
    await expect(planRegion).toBeVisible();
    await expect(
      page.getByText(
        '执行计划缺少校验摘要，已阻止启动。请重新读取计划后再试。',
      ),
    ).toBeVisible();

    // Submit button must remain disabled because planDigest is missing
    await expect(submitButton).toBeDisabled();

    // Retry button must be visible in plan region
    const retryButton = planRegion.getByRole('button', { name: '重试' });
    await expect(retryButton).toBeVisible();

    // 阻断态已渲染，初始阶段（含 agent 解析引发的多 key 请求）计数已稳定。
    const countBeforeRetry = planRequestCount;
    const planResponsePromise = page.waitForResponse(
      (res) =>
        res.url().includes('/api/rpc') &&
        res.status() === 200 &&
        res.request().postDataJSON()?.path === 'workflow.plan',
      { timeout: 15_000 },
    );

    retryClicked = true;
    await retryButton.click();
    const secondPlanRes = await planResponsePromise;
    const planBody = (await secondPlanRes.json()) as {
      result?: { digest?: string };
    };
    expect(planBody.result?.digest).toBeTruthy();

    // 不论初始阶段因 agent 解析发了几次，重试本身只额外发起一次计划请求。
    expect(planRequestCount).toBe(countBeforeRetry + 1);

    // Warning disappeared and normal plan summary rendered
    await expect(
      page.getByText(
        '执行计划缺少校验摘要，已阻止启动。请重新读取计划后再试。',
      ),
    ).toHaveCount(0);
    await expect(planRegion).toContainText('执行链路');

    // Submit button must recover to enabled state
    await expect(submitButton).toBeEnabled();
  });
});
