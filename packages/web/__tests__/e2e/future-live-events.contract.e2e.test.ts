import { test, expect } from './shared-fixture.js';

// Contract 7 (refactor plan, stage 3): while a run is active, an open page
// shows new events AND the provider's live output without a manual refresh.
//
// This is a `test.fail` placeholder. The event half already works: the server
// exposes `GET /api/sessions/:sessionId/events` as SSE and SessionDetailPage
// consumes it through useSessionStream (fetch + ReadableStream, because
// EventSource cannot carry the session token header). What stage 3 still owes
// is the "live output" half: the event vocabulary only has discrete lifecycle
// events (workflow/*, agent/status, gate/result, …); there is no incremental
// provider-output event and no UI surface rendering output as it is produced.
// The placeholder therefore asserts the dedicated streaming-output region on
// the session page. When stage 3 ships output streaming, define the final
// markup/testid and turn this into a real test driven by a slow fake provider
// that emits output before the job settles.
test.fail(
  'contract 7 (stage 3): the session page exposes a live provider-output region',
  async ({ page, server, fixture }) => {
    // Setup: start a mock run through the production RPC and open its session
    // page exactly like a user would. This succeeds on current code.
    const planResponse = await fetch(`${server.url}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        path: 'workflow.plan',
        input: { template: 'standard-delivery', agent: 'mock' },
      }),
    });
    const planJson = (await planResponse.json()) as {
      result: { digest: string };
    };
    const runResponse = await fetch(`${server.url}/api/rpc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-session-token': fixture.sessionToken,
      },
      body: JSON.stringify({
        path: 'project.run',
        input: {
          demandText: '合同 7 实时输出占位',
          template: 'standard-delivery',
          agent: 'mock',
          token: fixture.sessionToken,
          planDigest: planJson.result.digest,
        },
      }),
    });
    expect(runResponse.ok).toBe(true);
    const runBody = (await runResponse.json()) as {
      result: { run: { id: string }; sessionId?: string };
    };
    expect(runBody.result.sessionId).toBeTruthy();

    await page.goto(`${server.url}/sessions/${runBody.result.sessionId}`);
    // The discrete event feed is available today (setup must keep passing).
    await expect(page.locator('.event-feed')).toBeVisible();

    // Contract assertion (fails today): a region dedicated to streaming the
    // provider's incremental output while the job is active.
    await expect(page.locator('[data-testid="session-live-output"]')).toBeAttached();
  },
);
