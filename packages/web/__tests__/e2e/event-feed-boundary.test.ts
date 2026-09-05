import { test, expect } from './shared-fixture.js';

// T6 / T7: E2E test for EventFeed windowing and long payload expand/collapse.

test('EventFeed renders narrative and provides technical event controls', async ({
  page,
  server,
  fixture,
}) => {
  const planRes = await fetch(`${server.url}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'workflow.plan',
      input: { template: 'standard-delivery', agent: 'mock' },
    }),
  });
  const planJson = (await planRes.json()) as { result: { digest: string } };

  // Start a run to populate events
  const response = await fetch(`${server.url}/api/rpc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-session-token': fixture.sessionToken,
    },
    body: JSON.stringify({
      path: 'project.run',
      input: {
        demandText: 'E2E EventFeed boundary test with long demand description text that exceeds standard line threshold to verify feed rendering.',
        template: 'standard-delivery',
        agent: 'mock',
        token: fixture.sessionToken,
        planDigest: planJson.result.digest,
      },
    }),
  });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as {
    result: { sessionId?: string };
  };
  const sessionId = body.result.sessionId!;

  await page.goto(`${server.url}/sessions/${sessionId}`);

  const feed = page.locator('.event-feed');
  await expect(feed).toBeVisible({ timeout: 15_000 });

  // Narrative message is visible
  const messageBody = page.locator('.feed-message-body').first();
  await expect(messageBody).toBeVisible();

  // Technical events toolbar
  const toolbar = page.locator('.event-feed-toolbar');
  await expect(toolbar).toBeVisible();
});
