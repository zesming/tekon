import type { Page, Route } from '@playwright/test';
import { test, expect } from './shared-fixture.js';

const RUN_ID = 'release-a11y-run';

function projectOverview(status: string = 'paused') {
  return {
    project: { name: 'release-a11y', repoPath: '/tmp/release-a11y' },
    latestRun: {
      id: RUN_ID,
      status,
      recovery: {
        runStatus: status,
        cancelRecovery: null,
        resumeRecovery: null,
      },
    },
  };
}

function pendingDecision(id: string) {
  return {
    id,
    runId: RUN_ID,
    nodeId: `${id}-node`,
    gateResultId: null,
    status: 'pending',
    actor: null,
    note: null,
    createdAt: '2026-09-08T00:00:00.000Z',
    decidedAt: null,
    context: {
      request: 'Release approval',
      exactCommand: 'echo release',
      riskLabel: 'low',
      nodeRole: 'reviewer',
      approvalSummary: null,
      approvalEvaluation: null,
      gate: null,
    },
  };
}

async function routeApprovalQueue(page: Page, gateList: () => unknown) {
  await page.route('**/api/rpc', async (route: Route) => {
    const body = route.request().postDataJSON() as { path: string };
    if (body.path === 'project.overview') {
      return route.fulfill({ json: { result: projectOverview() } });
    }
    if (body.path === 'gate.list') {
      return route.fulfill({ json: { result: gateList() } });
    }
    return route.continue();
  });
}

test('approval notes have unique explicit labels for accessible form queries', async ({
  page,
  server,
}) => {
  await routeApprovalQueue(page, () => ({
    gates: [],
    pendingDecisions: [pendingDecision('decision-one'), pendingDecision('decision-two')],
  }));
  await page.goto(`${server.url}/advanced/approvals`);

  const notes = page.getByLabel('审批备注');
  await expect(notes).toHaveCount(2);
  const ids = await notes.evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).id),
  );
  expect(ids.every(Boolean)).toBe(true);
  expect(new Set(ids).size).toBe(ids.length);

  const associatedLabels = await page.locator('label').evaluateAll(
    (labels, expectedIds) =>
      labels
        .filter((label) => expectedIds.includes(label.getAttribute('for') ?? ''))
        .map((label) => ({ forId: label.getAttribute('for'), text: label.textContent?.trim() })),
    ids,
  );
  expect(associatedLabels).toEqual(
    ids.map((id) => ({ forId: id, text: '审批备注' })),
  );
});

test('RPC failures are exposed as an alert and retry recovers the approval queue', async ({
  page,
  server,
}) => {
  let gateAttempts = 0;
  await page.route('**/api/rpc', async (route: Route) => {
    const body = route.request().postDataJSON() as { path: string };
    if (body.path === 'project.overview') {
      return route.fulfill({ json: { result: projectOverview() } });
    }
    if (body.path === 'gate.list') {
      gateAttempts += 1;
      if (gateAttempts === 1) {
        return route.fulfill({
          status: 503,
          json: {
            error: {
              code: 'INTERNAL_ERROR',
              message: '受控 RPC 失败，请重试',
            },
          },
        });
      }
      return route.fulfill({ json: { result: { gates: [], pendingDecisions: [] } } });
    }
    return route.continue();
  });
  await page.goto(`${server.url}/advanced/approvals`);

  const banner = page.locator('[role="alert"]').filter({ hasText: '受控 RPC 失败，请重试' });
  await expect(banner).toBeVisible();
  await expect(banner).toHaveAttribute('aria-atomic', 'true');
  await banner.getByRole('button', { name: '重试' }).click();
  await expect(page.getByText('没有待处理审批')).toBeVisible();
  await expect(banner).toHaveCount(0);
});

function reviewSurface(status: string) {
  return {
    runId: RUN_ID,
    workflowStatus: status,
    provider: 'mock',
    recovery: {
      runStatus: status,
      cancelRecovery: null,
      resumeRecovery: null,
    },
    demand: {
      id: 'release-demand',
      title: 'Release accessibility review',
      body: 'Release accessibility review',
    },
    readiness: { runId: RUN_ID, ready: true, score: 1, checks: [] },
    prePullRequestReadiness: {},
    artifacts: [],
    gates: [],
    gateFailureTriage: [],
    delivery: {
      status: 'not-started',
      prUrl: null,
      package: null,
      prBody: null,
      diff: { files: 0, additions: 0, deletions: 0 },
    },
    evidenceGroups: [],
    nextCommands: [],
  };
}

test('run control receipts survive a terminal refresh after the controls disappear', async ({
  page,
  server,
}) => {
  let status = 'running';
  await page.route('**/api/rpc', async (route: Route) => {
    const body = route.request().postDataJSON() as { path: string };
    if (body.path === 'project.overview') {
      return route.fulfill({ json: { result: projectOverview(status) } });
    }
    if (body.path === 'review.get') {
      return route.fulfill({ json: { result: reviewSurface(status) } });
    }
    if (body.path === 'project.pause') {
      status = 'paused';
      return route.fulfill({ json: { result: { run: { id: RUN_ID, status } } } });
    }
    if (body.path === 'project.resume') {
      status = 'passed';
      return route.fulfill({ json: { result: { run: { id: RUN_ID, status } } } });
    }
    return route.continue();
  });
  await page.goto(`${server.url}/advanced/runs/${RUN_ID}`);

  await page.getByRole('button', { name: '暂停运行' }).click();
  await expect(page.getByRole('button', { name: '恢复运行' })).toBeVisible();
  const receipt = page.locator('.run-controls [role="status"]');
  await expect(receipt).toContainText('暂停请求已记录');

  await page.getByRole('button', { name: '恢复运行' }).click();
  await expect(page.getByRole('button', { name: '暂停运行' })).toHaveCount(0);
  await expect(receipt).toContainText('运行已结束（passed）');
  await expect(receipt.getByRole('button', { name: '关闭运行回执' })).toBeVisible();

  const flashDismissals = page.locator('.flash-item button[aria-label="关闭通知"]');
  while ((await flashDismissals.count()) > 0) {
    await flashDismissals.first().click();
  }
  await expect(receipt).toBeVisible();

  await receipt.getByRole('button', { name: '关闭运行回执' }).click();
  await expect(receipt).toHaveCount(0);
});
