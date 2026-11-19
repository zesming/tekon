import { type Response } from '@playwright/test';

import { test, expect } from './shared-fixture.js';

// PD-08：首页 SessionComposer 的运行模式/模板/代理三选。
// 验证：
// 1) 三个控件渲染且默认值正确（workflow 模式、模板留空走服务端轻量默认、
//    代理取自 project.overview.defaultAgent）；
// 2) 切换模板/代理会以全量入参重新请求 workflow.plan（缓存 key 随选择变化）；
// 3) Goal 互斥：Goal 模式禁用模板并不带 template/profile；dsh-headless 强制
//    切到 Goal；
// 4) 提交时 project.run 携带所选模板；默认留空时不带 template，由服务端回落
//    lightweight-delivery。
//
// 注意：shared-fixture 的 goto 包装会补 #token 片段，同路径 goto 退化为 hash
// 导航而不重载文档，测试体注册的 route 会漏掉首屏请求。因此每个用例用唯一
// 查询串强制完整加载（与 session-composer-admission 的 ?fresh= 同模式）。

interface PlanCall {
  mode?: string;
  template?: string;
  agent?: string;
  profile?: string;
}

function planCallPredicate(
  input: Partial<PlanCall>,
): (response: Response) => boolean {
  return (response) => {
    if (!response.url().includes('/api/rpc') || response.status() !== 200) {
      return false;
    }
    try {
      const body = response.request().postDataJSON();
      if (body.path !== 'workflow.plan') return false;
      return Object.entries(input).every(
        ([key, value]) => body.input[key] === value,
      );
    } catch {
      return false;
    }
  };
}

test.describe('PD-08 SessionComposer 运行模式/模板/代理三选', () => {
  test('三个控件按默认值渲染，目录包含轻量与标准模板', async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/?pd08=defaults`);

    const modeSelect = page.locator('#composer-mode');
    const templateSelect = page.locator('#composer-template');
    const agentSelect = page.locator('#composer-agent');

    await expect(modeSelect).toHaveValue('workflow');
    await expect(templateSelect).toHaveValue('');
    // fixture 的 project.overview defaultAgent 为 codex。
    await expect(agentSelect).toHaveValue('codex');

    await expect(
      templateSelect.locator('option[value="lightweight-delivery"]'),
    ).toHaveCount(1);
    await expect(
      templateSelect.locator('option[value="standard-delivery"]'),
    ).toHaveCount(1);
    await expect(page.getByText('默认轻量模板')).toBeVisible();
  });

  test('切换模板与代理会以全量入参刷新执行计划', async ({ page, server }) => {
    const planCalls: PlanCall[] = [];
    await page.route('**/api/rpc', async (route) => {
      try {
        const body = route.request().postDataJSON();
        if (body.path === 'workflow.plan') planCalls.push(body.input);
      } catch {
        // 非 JSON 请求直接放行。
      }
      await route.continue();
    });

    await page.goto(`${server.url}/?pd08=plan-refresh`);
    await expect(page.locator('#composer-agent')).toHaveValue('codex');

    // 初始计划：workflow 模式、无模板（服务端回落 lightweight-delivery）、
    // human-web profile。首屏会先以空 agent 请求一次、overview 落地后再带
    // codex 请求一次，两次都不应带 template。
    await expect
      .poll(() =>
        planCalls.some(
          (call) =>
            call.mode === 'workflow' &&
            call.template === undefined &&
            call.profile === 'human-web',
        ),
      )
      .toBe(true);

    // 显式选择 standard-delivery：计划请求必须带上 template 且保持 profile。
    const standardPlan = page.waitForResponse(
      planCallPredicate({
        mode: 'workflow',
        template: 'standard-delivery',
        profile: 'human-web',
      }),
      { timeout: 15_000 },
    );
    await page.locator('#composer-template').selectOption('standard-delivery');
    await standardPlan;

    // 切换代理：计划请求以新 agent 重发，模板选择保持不变。
    const mockPlan = page.waitForResponse(
      planCallPredicate({
        mode: 'workflow',
        template: 'standard-delivery',
        agent: 'mock',
        profile: 'human-web',
      }),
      { timeout: 15_000 },
    );
    await page.locator('#composer-agent').selectOption('mock');
    await mockPlan;

    // 选择状态在刷新后仍然保留。
    await expect(page.locator('#composer-template')).toHaveValue(
      'standard-delivery',
    );
    await expect(page.locator('#composer-agent')).toHaveValue('mock');
  });

  test('Goal 模式禁用模板并不带 template/profile，dsh-headless 强制 Goal', async ({
    page,
    server,
  }) => {
    const planCalls: PlanCall[] = [];
    await page.route('**/api/rpc', async (route) => {
      try {
        const body = route.request().postDataJSON();
        if (body.path === 'workflow.plan') planCalls.push(body.input);
      } catch {
        // 非 JSON 请求直接放行。
      }
      await route.continue();
    });

    await page.goto(`${server.url}/?pd08=goal-mutex`);
    const modeSelect = page.locator('#composer-mode');
    const templateSelect = page.locator('#composer-template');
    const agentSelect = page.locator('#composer-agent');
    await expect(agentSelect).toHaveValue('codex');

    const goalPlan = page.waitForResponse(
      planCallPredicate({ mode: 'goal', agent: 'codex' }),
      { timeout: 15_000 },
    );
    await modeSelect.selectOption('goal');
    await goalPlan;
    await expect(templateSelect).toBeDisabled();
    await expect(modeSelect).toHaveValue('goal');

    // Goal 的计划请求不带 template 与 profile。
    const goalIndex = planCalls.findIndex((call) => call.mode === 'goal');
    expect(goalIndex).toBeGreaterThanOrEqual(0);
    const goalCall = planCalls[goalIndex]!;
    expect(goalCall.template).toBeUndefined();
    expect(goalCall.profile).toBeUndefined();
    expect(goalCall.agent).toBe('codex');

    // 切回 workflow 后模板控件恢复可用。相同 planKey 的首屏计划仍新鲜，
    // 查询缓存直接命中而不重发请求——这正是 planKey 带全量入参的目的。
    await modeSelect.selectOption('workflow');
    await expect(templateSelect).toBeEnabled();
    await expect(modeSelect).toHaveValue('workflow');
    await expect(
      page.getByRole('region', { name: '执行前计划' }),
    ).toContainText('执行链路');
    expect(
      planCalls.slice(goalIndex).some((call) => call.mode === 'workflow'),
    ).toBe(false);

    // dsh-headless 仅 Goal 可用：选择代理后模式自动切到 Goal 并清空模板。
    const dshPlan = page.waitForResponse(
      planCallPredicate({ mode: 'goal', agent: 'dsh-headless' }),
      { timeout: 15_000 },
    );
    await agentSelect.selectOption('dsh-headless');
    await dshPlan;
    await expect(modeSelect).toHaveValue('goal');
    await expect(templateSelect).toHaveValue('');
    await expect(templateSelect).toBeDisabled();

    const dshCall = planCalls.find((call) => call.agent === 'dsh-headless')!;
    expect(dshCall.mode).toBe('goal');
    expect(dshCall.template).toBeUndefined();
  });

  test('提交按选择携带 template；默认留空时不带 template 交由服务端回落', async ({
    page,
    server,
  }) => {
    const runInputs: Record<string, unknown>[] = [];
    await page.route('**/api/rpc', async (route) => {
      let isProjectRun = false;
      try {
        const body = route.request().postDataJSON();
        isProjectRun = body.path === 'project.run';
        if (isProjectRun) runInputs.push(body.input);
      } catch {
        isProjectRun = false;
      }
      if (isProjectRun) {
        // 不真正创建运行，仅验证准入载荷。
        return route.fulfill({
          status: 400,
          json: {
            error: {
              code: 'BAD_REQUEST',
              message: 'PD08 测试结束，未创建运行',
            },
          },
        });
      }
      return route.continue();
    });

    await page.goto(`${server.url}/?pd08=submit`);
    const demandInput = page.getByLabel('新建受控交付任务');
    const submitButton = page.getByRole('button', {
      name: '启动受控交付',
    });

    // 默认（模板留空）提交：载荷不带 template，代理仍随选择上报。
    await demandInput.fill('默认轻量模板提交验证');
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    await expect(page.getByText('PD08 测试结束，未创建运行')).toBeVisible();
    expect(runInputs).toHaveLength(1);
    expect(runInputs[0]).not.toHaveProperty('template');
    expect(runInputs[0]).toMatchObject({ agent: 'codex' });
    expect(runInputs[0]).toHaveProperty('planDigest');

    // 显式选择 standard-delivery 后再次提交：载荷必须携带该模板。
    const standardPlan = page.waitForResponse(
      planCallPredicate({
        mode: 'workflow',
        template: 'standard-delivery',
        profile: 'human-web',
      }),
      { timeout: 15_000 },
    );
    await page.locator('#composer-template').selectOption('standard-delivery');
    await standardPlan;
    await expect(submitButton).toBeEnabled();
    await submitButton.click();
    await expect.poll(() => runInputs.length).toBe(2);
    expect(runInputs[1]).toMatchObject({
      template: 'standard-delivery',
      agent: 'codex',
    });
    expect(runInputs[1]).toHaveProperty('planDigest');
  });
});
