import { test, expect } from './shared-fixture.js';

// Ninth-review annotation 16.4 / P2-UX-01: when the server signals
// replay-truncated (reconnect budget or slow-client backpressure cap exceeded),
// the Session view must show a non-blocking notice that the user can dismiss.
// The stream switches to the recent tail; the banner must not block the feed.

test('Session view shows a dismissible truncation notice on replay-truncated', async ({
  page,
  server,
  fixture,
}) => {
  // Start a run so a session with events exists.
  const planRes = await fetch(`${server.url}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'workflow.plan',
      input: { template: 'standard-delivery', agent: 'mock' },
    }),
  });
  const planJson = (await planRes.json()) as { result: { digest: string } };

  const response = await fetch(`${server.url}/api/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-token': fixture.sessionToken,
    },
    body: JSON.stringify({
      path: 'project.run',
      input: {
        demandText: 'E2E truncation banner test.',
        template: 'standard-delivery',
        agent: 'mock',
        token: fixture.sessionToken,
        planDigest: planJson.result.digest,
      },
    }),
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { result: { sessionId?: string } };
  const sessionId = body.result.sessionId!;

  // Intercept the SSE stream and inject a replay-truncated control frame
  // before the first business event, then let the rest pass through.
  let intercepted = false;
  await page.route(`**/api/sessions/${sessionId}/events**`, async (route) => {
    if (!intercepted) {
      intercepted = true;
      const body =
        'event: replay-truncated\n' +
        'data: {"cursor":1,"reason":"test injection"}\n\n';
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
        body,
      });
    } else {
      await route.continue();
    }
  });

  await page.goto(`${server.url}/sessions/${sessionId}`);

  const banner = page.locator('.feed-truncation-banner');
  await expect(banner).toBeVisible({ timeout: 15_000 });
  await expect(banner).toContainText('已切换到最近记录');

  // The banner is non-blocking: the feed still renders.
  await expect(page.locator('.event-feed')).toBeVisible();

  // Dismiss it.
  await banner.getByRole('button', { name: '关闭' }).click();
  await expect(banner).toHaveCount(0);
});
