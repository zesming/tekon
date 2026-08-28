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
  expect(
    body.result.sessionId,
    'project.run must return a sessionId',
  ).toBeTruthy();
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
  await expect(feed).toHaveAttribute('role', 'log');
  await expect(feed).toHaveAttribute('aria-live', 'polite');
  await expect(feed).toHaveAttribute('aria-atomic', 'false');

  // A user/message row is present (the run's demand text becomes user/message).
  await expect(
    page.locator('.feed-row-message .feed-author-user').first(),
  ).toBeVisible({ timeout: 15_000 });

  // Human-relevant lifecycle rows remain visible in the default narrative.
  await expect(page.locator('[data-event-type="workflow/started"]')).toBeVisible({
    timeout: 15_000,
  });

  // Raw worktree/checkpoint/node detail stays available, but no longer floods
  // the default human-facing narrative.
  await expect(
    page.locator('[data-event-type="worktree/leased"]'),
  ).toHaveCount(0);
  const technicalToggle = page.getByRole('button', {
    name: '显示技术事件',
  });
  await expect(technicalToggle).toBeVisible();
  await expect(technicalToggle).toHaveAttribute('aria-pressed', 'false');
  await technicalToggle.click();
  await expect(
    page.locator('[data-event-type="worktree/leased"]').first(),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '隐藏技术事件' }),
  ).toHaveAttribute('aria-pressed', 'true');

  // The connection indicator resolves to live (replay complete, streaming).
  await expect(page.locator('.session-conn-live')).toBeVisible({
    timeout: 15_000,
  });

  // The point-in-time session.get snapshot may still say `active`; the header
  // must follow the same live lifecycle projection as the controls/result rail.
  const headerStatus = page.locator('.page-subtitle .badge').first();
  await expect(headerStatus).toHaveText('已通过', { timeout: 15_000 });
  await expect(headerStatus).toHaveClass(/badge-passed/u);

  // UX-01: connection state is a complete, non-interrupting status update.
  await expect(page.locator('.session-conn')).toHaveAttribute('role', 'status');
  await expect(page.locator('.session-conn')).toHaveAttribute(
    'aria-live',
    'polite',
  );
  await expect(page.locator('.session-conn')).toHaveAttribute(
    'aria-atomic',
    'true',
  );
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

  // The single workspace is information, not a disabled fake selector.
  const workspace = page.getByRole('group', { name: '当前工作区' });
  await expect(workspace).toBeVisible({ timeout: 15_000 });
  await expect(workspace).toContainText('当前项目');
  await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '启动受控交付' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '显示会话令牌' }),
  ).toBeVisible();

  const link = page.locator(`a[href="/sessions/${sessionId}"]`);
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
  await expect(page.locator('.event-feed')).toBeVisible({ timeout: 15_000 });

  // A terminal result is the first inspector card; repeated tool/artifact
  // history is bounded by default instead of duplicating the entire feed.
  const cards = page.locator('.session-side-cards .session-card');
  await expect(cards).toHaveCount(7, { timeout: 15_000 });
  await expect(cards.first()).toHaveClass(/session-card-result/u);
  await expect(cards.first()).toContainText('运行结束');
  const cardHistoryToggle = page.getByRole('button', {
    name: /显示另外 \d+ 条工具与产物历史/u,
  });
  await expect(cardHistoryToggle).toBeVisible();
  await expect(cardHistoryToggle).toHaveAttribute('aria-expanded', 'false');

  // Expanding remains available for audit/debug use.
  await cardHistoryToggle.click();
  await expect(
    page.getByRole('button', { name: '收起工具与产物历史' }),
  ).toHaveAttribute('aria-expanded', 'true');
  await expect(cards).toHaveCount(39);
});
