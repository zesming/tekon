import { join } from 'node:path';

import { test, expect } from './shared-fixture.js';

// ---------------------------------------------------------------------------
// PD-21：交付声明驱动的 Web 行为
//  1. 不可交付模板（无 delivery 声明）→ Prepare 按钮禁用且中文原因可见，
//     Dry-Run 逐项检查展示 delivery-not-declared 失败项。
//  2. 可交付运行 prepare 后，Run Detail 的 DeliveryTab 展示交付落点与下一步。
// ---------------------------------------------------------------------------

interface RpcEnvelope<T> {
  result?: T;
  error?: { code: string; message: string };
}

async function rpcCall<T>(
  baseUrl: string,
  path: string,
  input?: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(`${baseUrl}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input === undefined ? { path } : { path, input }),
  });
  const body = (await response.json()) as RpcEnvelope<T>;
  if (!response.ok || body.error) {
    throw new Error(
      `RPC ${path} failed: ${response.status} ${JSON.stringify(body.error)}`,
    );
  }
  return body.result as T;
}

async function startRunAndWait(
  baseUrl: string,
  sessionToken: string,
  template: string,
  acceptedStatuses: string[],
  timeoutMs = 25_000,
): Promise<string> {
  const plan = await rpcCall<{ digest: string }>(baseUrl, 'workflow.plan', {
    template,
    agent: 'mock',
  });

  const started = await rpcCall<{ run: { id: string } }>(
    baseUrl,
    'project.run',
    {
      demandText: `PD-21 e2e run for template ${template}.`,
      template,
      agent: 'mock',
      token: sessionToken,
      planDigest: plan.digest,
    },
  );
  const runId = started.run.id;

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const overview = await rpcCall<{
      latestRun: { id: string; status: string } | null;
    }>(baseUrl, 'project.overview');
    const run = overview.latestRun;
    if (run && run.id === runId && acceptedStatuses.includes(run.status)) {
      return runId;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `run ${runId} did not reach ${acceptedStatuses.join('/')} within ${timeoutMs}ms`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
}

test.describe('PD-21 delivery declaration', () => {
  test('non-deliverable template disables Prepare PR with a visible reason', async ({
    page,
    fixture,
    server,
  }) => {
    // plan-only 无 delivery 声明块，运行在人工门禁处暂停即已冻结快照。
    const runId = await startRunAndWait(
      server.url,
      fixture.sessionToken,
      'plan-only',
      ['paused', 'passed'],
    );

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${server.url}/advanced/delivery`);

    await expect(
      page.getByRole('heading', { name: 'Delivery' }),
    ).toBeVisible();

    // 显式建立会话（与 create-pr-approval 旅程一致）。
    await page.getByRole('button', { name: /连接/ }).click();
    await page.getByLabel('Session token').fill(fixture.sessionToken);
    await page.getByRole('button', { name: '应用连接' }).click();

    const prepareButton = page.getByRole('button', { name: 'Prepare PR' });
    await expect(prepareButton).toBeVisible();
    await expect(prepareButton).toBeDisabled();

    // 禁用原因取首个失败检查的中文标签。
    await expect(page.getByText(/不可交付/).first()).toBeVisible();

    // Dry-Run 卡片中的逐项准备度检查同样标红不可交付项。
    await page.getByRole('button', { name: 'Dry Run' }).click();
    await expect(page.getByText('交付准备度检查')).toBeVisible();
    await expect(page.getByText(/✕\s*不可交付/)).toBeVisible();

    // Run 详情 DeliveryTab：不可交付时只显示阻断原因，不展示尚未创建的
    // 「幻影分支」行（diff 区的不可用原因文本可能含约定分支名，故按
    // 指引卡专属标签断言）。
    await page.goto(`${server.url}/advanced/runs/${runId}/delivery`);
    await expect(page.getByText('交付落点与下一步')).toBeVisible();
    await expect(page.getByText('当前不可进入 PR 准备')).toBeVisible();
    await expect(page.getByText('不可交付').first()).toBeVisible();
    await expect(page.getByText('交付分支', { exact: true })).toHaveCount(0);
    await expect(page.getByText('Worktree', { exact: true })).toHaveCount(0);
  });

  test('DeliveryTab shows delivery locations and next steps after prepare', async ({
    page,
    fixture,
    server,
  }) => {
    const runId = await startRunAndWait(
      server.url,
      fixture.sessionToken,
      'standard-delivery',
      ['passed'],
    );

    await rpcCall(server.url, 'delivery.prepare', {
      runId,
      token: fixture.sessionToken,
    });

    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(`${server.url}/advanced/runs/${runId}/delivery`);

    // 指引卡：分支、PR 包落点、下一步命令。
    await expect(page.getByText('交付落点与下一步')).toBeVisible();
    await expect(
      page.getByText(`tekon-delivery/${runId}`).first(),
    ).toBeVisible();
    await expect(
      page.getByText(join('.tekon', 'runs', runId, 'delivery', 'pr-package.md')).first(),
    ).toBeVisible();
    await expect(page.getByText('下一步', { exact: true })).toBeVisible();
    await expect(page.getByText(/^\$\s+tekon\s+status/).first()).toBeVisible();
  });
});
