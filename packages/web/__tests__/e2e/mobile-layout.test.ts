import { test, expect } from './shared-fixture.js';

// F6-P0-01 (sixth-review authoritative): the Web layout was unusable at mobile
// widths — a fixed 232px sidebar + `.main { margin-left: 232px }` with NO
// max-width breakpoints, and the only responsive rule lived in dead CSS that
// `main.tsx` never imported (`sessions.css` — so the entire Session UI, the
// default landing page, rendered unstyled). This suite locks the fix in a real
// browser:
//   - mobile (390px): no page-level horizontal overflow on the sessions list,
//     the session-detail page (whose .session-columns 860px fold only works now
//     that sessions.css is loaded), and an /advanced page (multi-column grids —
//     the highest-risk overflow surface);
//   - the sidebar is an off-canvas drawer toggled by an accessible hamburger,
//     dismissible via overlay, Esc, and route change;
//   - desktop (1440px): the persistent sidebar + `.main` left margin do not
//     regress and the hamburger is absent.

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

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
        demandText: 'E2E F6-P0-01: mobile session-detail layout.',
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

/** True when the document does not overflow its own viewport horizontally. */
async function hasNoHorizontalOverflow(page: import('@playwright/test').Page) {
  return page.evaluate(
    () =>
      // +1px tolerance for sub-pixel rounding / scrollbar width.
      document.documentElement.scrollWidth <= window.innerWidth + 1,
  );
}

test.describe('mobile layout (390px)', () => {
  test.use({ viewport: MOBILE });

  test('sessions, session-detail, and an advanced page never overflow horizontally', async ({
    page,
    server,
    fixture,
  }) => {
    // Default sessions page.
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
      timeout: 15_000,
    });
    expect(await hasNoHorizontalOverflow(page)).toBe(true);

    // Session Detail — the page most affected by the revived sessions.css
    // (its .session-columns 860px fold was dead code until main.tsx imported
    // the stylesheet). Start a real run to get a session to open.
    const { sessionId } = await startRun(server.url, fixture.sessionToken);
    await page.goto(`${server.url}/sessions/${sessionId}`);
    await expect(page.locator('.event-feed')).toBeVisible({ timeout: 15_000 });
    expect(await hasNoHorizontalOverflow(page)).toBe(true);

    // Advanced runs page — .panel-grid / .approval-meta multi-column grids and
    // toolbar <select>s are the highest overflow risk; testing only the
    // sessions page would not lock this. `run_1` comes from the fixture.
    await page.goto(`${server.url}/advanced/runs`);
    await expect(
      page.getByRole('heading', { name: '运行管理 Runs' }),
    ).toBeVisible({ timeout: 15_000 });
    expect(await hasNoHorizontalOverflow(page)).toBe(true);

    // Advanced dashboard (heatmap / stat cards).
    await page.goto(`${server.url}/advanced`);
    await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible({
      timeout: 15_000,
    });
    expect(await hasNoHorizontalOverflow(page)).toBe(true);
  });

  test('the sidebar is an off-canvas drawer toggled by an accessible hamburger', async ({
    page,
    server,
  }) => {
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
      timeout: 15_000,
    });

    const sidebar = page.locator('#app-sidebar');
    const toggle = page.getByRole('button', { name: '打开导航' });

    // Drawer is hidden by default on mobile (visibility:hidden, not just
    // translated — Playwright treats translateX(-100%) as still "visible", so
    // the CSS uses `visibility:hidden` and this assertion is a true lock).
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(sidebar).toBeHidden();

    // Open via the hamburger → drawer visible, nav links reachable.
    await toggle.click();
    await expect(page.getByRole('button', { name: '关闭导航' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    await expect(sidebar).toBeVisible();
    const navLink = page.getByRole('link', { name: '高级 Advanced' });
    await expect(navLink).toBeVisible();

    // Tapping the overlay closes the drawer.
    await page.locator('.nav-overlay').click();
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole('button', { name: '打开导航' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // Esc closes the drawer (keyboard dismissal for the modal-style overlay).
    await toggle.click();
    await expect(sidebar).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();
    await expect(page.getByRole('button', { name: '打开导航' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );

    // Navigating via a nav link closes the drawer (route change → dismiss).
    await toggle.click();
    await expect(sidebar).toBeVisible();
    await page.getByRole('link', { name: '高级 Advanced' }).click();
    await expect(page).toHaveURL(/\/advanced$/);
    await expect(sidebar).toBeHidden();
  });
});

test.describe('desktop layout (1440px) — no regression', () => {
  test.use({ viewport: DESKTOP });

  test('the persistent sidebar stays put and no hamburger appears', async ({
    page,
    server,
  }) => {
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
      timeout: 15_000,
    });

    // Persistent sidebar is visible; no drawer hamburger on desktop.
    const sidebar = page.locator('#app-sidebar');
    await expect(sidebar).toBeVisible();
    await expect(page.getByRole('button', { name: '打开导航' })).toHaveCount(0);

    // `.main` keeps its left margin so content is not under the fixed sidebar.
    const marginLeft = await page
      .locator('.main')
      .evaluate((el) => getComputedStyle(el).marginLeft);
    expect(marginLeft).toBe('232px');
  });
});
