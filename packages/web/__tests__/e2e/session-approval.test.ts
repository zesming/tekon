import { test, expect } from './shared-fixture.js';

// Phase 3 3c: inline approval. Starts a run through a human-gate template (the
// mock agent completes the node, the human gate creates a pending decision, and
// dual-write emits approval/requested). The Session UI's right rail renders the
// inline DecisionCard (context pulled from gate.list, S1) and approves through
// the existing gate.approve RPC — governance semantics unchanged (§0.3).

async function startApprovalRun(
  baseUrl: string,
  token: string,
): Promise<{ runId: string; sessionId: string }> {
  const response = await fetch(`${baseUrl}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({
      path: 'project.run',
      input: {
        demandText: 'E2E 3c: inline approval through the session UI.',
        template: 'feature-approval',
        agent: 'mock',
        token,
      },
    }),
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as {
    result: { run: { id: string }; sessionId?: string };
  };
  expect(body.result.sessionId).toBeTruthy();
  return { runId: body.result.run.id, sessionId: body.result.sessionId! };
}

async function fetchOverview(baseUrl: string, token: string) {
  const res = await fetch(`${baseUrl}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({ path: 'project.overview' }),
  });
  return (await res.json()) as {
    result: { latestRun: { id: string; status: string } | null };
  };
}

async function waitForStatus(
  baseUrl: string,
  runId: string,
  token: string,
  statuses: string[],
): Promise<string> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const body = await fetchOverview(baseUrl, token);
    const run = body.result.latestRun;
    if (run && run.id === runId && statuses.includes(run.status)) {
      return run.status;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `run ${runId} did not reach ${statuses.join('/')} within 30s`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('inline approval: approve a pending human decision from the session UI', async ({
  page,
  server,
  fixture,
}) => {
  const { runId, sessionId } = await startApprovalRun(
    server.url,
    fixture.sessionToken,
  );
  // The human gate pauses the run awaiting a decision.
  await waitForStatus(server.url, runId, fixture.sessionToken, [
    'paused',
    'blocked',
  ]);

  await page.goto(`${server.url}/sessions/${sessionId}`);

  // Enter the session token in the TopBar (mirrors a real user): this populates
  // AuthContext so the inline approval's body token is set. gate.approve
  // validates the body token server-side (assertSessionToken), so the header
  // monkeypatch alone is not enough for the write.
  await page.getByLabel('Session token').fill(fixture.sessionToken);

  // The inline approval card renders (context pulled from gate.list).
  const approvals = page.getByTestId('session-approvals');
  await expect(approvals).toBeVisible({ timeout: 15_000 });

  // DecisionForm two-step confirm with DISTINCT accessible names per state
  // (mirrors dashboard.test.ts exactly): click "✓ 批准" → assert "确认批准?"
  // committed → click "确认批准?" to execute gate.approve.
  await approvals.getByRole('button', { name: '✓ 批准' }).click();
  await expect(
    approvals.getByRole('button', { name: '确认批准?' }),
  ).toBeVisible({ timeout: 5_000 });
  await approvals.getByRole('button', { name: '确认批准?' }).click();

  // Client-observable proof the decision resolved: the server processed
  // gate.approve (200), the run advanced past the human gate, and the pending
  // approval clears. Assert on the RPC result via the page rather than polling
  // the server after it may be tearing down.
  await expect
    .poll(
      async () => {
        const res = await page.request.post(`${server.url}/api/rpc`, {
          headers: { 'x-session-token': fixture.sessionToken },
          data: { path: 'gate.list', input: { runId } },
        });
        if (!res.ok()) return 'pending';
        const body = (await res.json()) as {
          result: { pendingDecisions: unknown[] };
        };
        return body.result.pendingDecisions.length === 0 ? 'cleared' : 'pending';
      },
      { timeout: 20_000, intervals: [200, 500, 1000] },
    )
    .toBe('cleared');
});
