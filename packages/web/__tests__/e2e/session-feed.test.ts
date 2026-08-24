import { test, expect } from './shared-fixture.js';

// Phase 3 3b: browser-level SSE consumption (moved from 3a per review S5 —
// 3a had no page to host the stream). Starts a real mock-agent run through the
// RPC API (which creates a session + emits agent-loop events via dual-write),
// then opens the Session Detail page and asserts the feed renders the streamed
// narrative and the connection reaches "live".

/** Start a mock-agent run and return its {runId, sessionId}. */
async function startRun(
  baseUrl: string,
  token: string,
): Promise<{ runId: string; sessionId: string }> {
  const response = await fetch(`${baseUrl}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({
      path: 'project.run',
      input: {
        demandText: 'E2E 3b: session feed renders streamed events.',
        template: 'standard-delivery',
        agent: 'mock',
        token,
      },
    }),
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as {
    result: { run: { id: string }; sessionId?: string };
  };
  expect(body.result.sessionId, 'project.run must return a sessionId').toBeTruthy();
  return { runId: body.result.run.id, sessionId: body.result.sessionId! };
}

async function waitForRunPassed(
  baseUrl: string,
  runId: string,
  token: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ path: 'project.overview' }),
    });
    if (res.ok) {
      const body = (await res.json()) as {
        result: { latestRun: { id: string; status: string } | null };
      };
      const run = body.result.latestRun;
      if (run && run.id === runId && run.status === 'passed') return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`run ${runId} did not reach passed within 30s`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

test('Session Detail streams the event feed and reaches a live connection', async ({
  page,
  server,
  fixture,
}) => {
  const { runId, sessionId } = await startRun(server.url, fixture.sessionToken);
  await waitForRunPassed(server.url, runId, fixture.sessionToken);

  // Open the session; the SSE client replays sinceSeq=0 then goes live.
  await page.goto(`${server.url}/sessions/${sessionId}`);

  // The feed renders the streamed narrative: at least a user message and the
  // agent-loop / lifecycle events produced by the mock run.
  const feed = page.locator('.event-feed');
  await expect(feed).toBeVisible({ timeout: 15_000 });

  // A user/message row is present (the run's demand text becomes user/message).
  await expect(
    page.locator('.feed-row-message .feed-author-user').first(),
  ).toBeVisible({ timeout: 15_000 });

  // Lifecycle/agent-loop rows arrived (step or turn or governance rows).
  await expect(
    page.locator('.feed-row-step, .feed-row-turn, .feed-row-governance').first(),
  ).toBeVisible({ timeout: 15_000 });

  // The connection indicator resolves to live (replay complete, streaming).
  await expect(page.locator('.session-conn-live')).toBeVisible({
    timeout: 15_000,
  });
});

test('Sessions list shows the started session and links to its detail', async ({
  page,
  server,
  fixture,
}) => {
  const { runId, sessionId } = await startRun(server.url, fixture.sessionToken);
  await waitForRunPassed(server.url, runId, fixture.sessionToken);

  // Phase 3 3d: the session list is the default route `/`.
  await page.goto(server.url);
  const link = page.locator(`a[href="/sessions/${sessionId}"]`);
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
  await expect(page.locator('.event-feed')).toBeVisible({ timeout: 15_000 });
});
