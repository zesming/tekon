import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { test, expect } from './shared-fixture.js';

const outputDir =
  process.env.REVIEW14_POSTFIX_DIR ??
  join(process.cwd(), 'review14-postfix-screenshots');

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
          'Review 14 post-fix visual verification for the controlled-delivery experience.',
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

test('capture the post-fix Session product surfaces', async ({
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
  await page.goto(`${server.url}/?review14Postfix=${Date.now()}`);
  await expect(page.locator(`a[href="/sessions/${sessionId}"]`)).toBeVisible({
    timeout: 15_000,
  });
  await page.waitForTimeout(400);
  await page.screenshot({
    path: join(outputDir, '01-sessions-desktop-after.png'),
    fullPage: true,
  });

  await page.goto(`${server.url}/sessions/${sessionId}`);
  await expect(page.locator('.event-feed')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.page-subtitle .badge').first()).toHaveText(
    '已通过',
    { timeout: 15_000 },
  );
  await expect(
    page.getByRole('button', { name: '显示技术事件' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: /显示另外 \d+ 条工具与产物历史/u,
    }),
  ).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: join(outputDir, '02-session-detail-desktop-after.png'),
    fullPage: true,
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.nav-toggle')).toBeVisible();
  await page.waitForTimeout(300);
  await expect(page.locator('#app-sidebar')).toHaveCSS('visibility', 'hidden');
  await page.screenshot({
    path: join(outputDir, '03-session-detail-mobile-after.png'),
    fullPage: true,
  });
});
