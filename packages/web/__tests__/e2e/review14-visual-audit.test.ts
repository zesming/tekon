import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect } from './shared-fixture.js';

const outputDir =
  process.env.REVIEW14_SCREENSHOT_DIR ??
  join(process.cwd(), 'review14-screenshots');

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
        demandText:
          'Review 14 visual audit: inspect the human-facing controlled-delivery experience.',
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
  expect(body.result.sessionId).toBeTruthy();
  return { runId: body.result.run.id, sessionId: body.result.sessionId! };
}

async function waitForRunPassed(
  baseUrl: string,
  runId: string,
  token: string,
): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const response = await fetch(`${baseUrl}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({ path: 'project.overview' }),
    });
    if (response.ok) {
      const body = (await response.json()) as {
        result: { latestRun: { id: string; status: string } | null };
      };
      if (
        body.result.latestRun?.id === runId &&
        body.result.latestRun.status === 'passed'
      ) {
        return;
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`run ${runId} did not reach passed within 30 seconds`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function waitForViewAnimation(page: Parameters<typeof test>[0] extends never ? never : any) {
  // reset.css animates .view for 300ms. Waiting prevents a mid-fade capture
  // from looking like a disabled or inaccessible page.
  await page.waitForTimeout(400);
}

test('capture the current Session product surfaces for review 14', async ({
  page,
  server,
  fixture,
}) => {
  mkdirSync(outputDir, { recursive: true });
  const { runId, sessionId } = await startRun(
    server.url,
    fixture.sessionToken,
  );
  await waitForRunPassed(server.url, runId, fixture.sessionToken);

  await page.setViewportSize({ width: 1440, height: 1000 });
  // beforeEach has already loaded `/` and cached the pre-run list. A distinct
  // query string forces a real new document so this audit captures the current
  // server state instead of a fragment-only navigation reusing stale UI data.
  await page.goto(`${server.url}/?review14=${Date.now()}`);
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(`a[href="/sessions/${sessionId}"]`)).toBeVisible({
    timeout: 15_000,
  });
  await waitForViewAnimation(page);
  await page.screenshot({
    path: join(outputDir, '01-sessions-desktop.png'),
    fullPage: true,
  });

  await page.goto(`${server.url}/sessions/${sessionId}`);
  await expect(page.locator('.event-feed')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.session-card-result')).toBeVisible({
    timeout: 15_000,
  });
  await waitForViewAnimation(page);
  await page.screenshot({
    path: join(outputDir, '02-session-detail-desktop.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.nav-toggle')).toBeVisible();
  // Capture the ordinary content state, not an accidentally open navigation
  // drawer inherited from a previous interaction or responsive transition.
  const closeButton = page.getByRole('button', { name: '关闭侧边导航' });
  if (await closeButton.isVisible()) {
    await closeButton.click();
  }
  await expect(page.locator('#main-content')).not.toHaveAttribute('inert', '');
  await waitForViewAnimation(page);
  await page.screenshot({
    path: join(outputDir, '03-session-detail-mobile.png'),
    fullPage: true,
  });
});
