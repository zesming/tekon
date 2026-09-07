import { join } from 'node:path';
import { createSessionEventStore, createWriteQueue, openTekonDatabase } from '@tekon/core';
import { test, expect } from './shared-fixture.js';

for (const width of [320, 390, 600, 601, 768, 769, 1440]) {
  test(`Dashboard surfaces at ${width}px retain content and control geometry`, async ({ page, server, fixture }, info) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const db = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
    let sessionId: string;
    try {
      const store = createSessionEventStore(db, createWriteQueue());
      const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
      sessionId = (await store.createSession({ workspaceId: workspace.id, runId: 'run_1', profile: 'human-web', title: '交付验收：检查变更与运行证据' })).id;
      await store.appendEvent({ sessionId, type: 'user/message', payload: { text: '检查变更、构建结果和审批记录。' }, modelVisible: false });
      await store.appendEvent({ sessionId, type: 'approval/requested', payload: { runId: 'run_1', decisionId: 'decision_1' }, modelVisible: false });
      await store.updateSessionStatus(sessionId, 'awaiting-approval');
    } finally { db.close(); }
    const pages = [
      { name: 'sessions', path: '/', title: '受控交付' },
      { name: 'session', path: `/sessions/${sessionId}`, title: '交付验收：检查变更与运行证据' },
      { name: 'runs', path: '/advanced/runs', title: 'Runs' },
      { name: 'run', path: '/advanced/runs/run_1', title: 'run_1' },
      { name: 'approvals', path: '/advanced/approvals', title: 'Approvals' },
      { name: 'delivery', path: '/advanced/delivery', title: 'Delivery' },
      { name: 'config', path: '/advanced/config', title: 'Config' },
      { name: 'eval', path: '/advanced/eval', title: 'Evaluations' },
    ];
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    const geometry = [];
    for (const target of pages) {
      await page.goto(server.url + target.path);
      await expect(page.locator(target.name === 'run' ? '.run-header-id' : '.page-title')).toContainText(target.title);
      await expect(page.locator('.loading-spinner')).toHaveCount(0);
      if (target.name === 'session') await expect(page.locator('.approval-card').first()).toBeVisible();
      if (target.name === 'session' || target.name === 'approvals') {
        const clippedLinks = await page.locator('.link-strip a').evaluateAll(elements => elements.filter(element => {
          const bounds = element.getBoundingClientRect();
          const parent = element.closest('.link-strip')!.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(element);
          return bounds.left < parent.left - 1 || bounds.right > parent.right + 1 ||
            [...range.getClientRects()].some(rect => rect.left < bounds.left - 1 || rect.right > bounds.right + 1 ||
              rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1);
        }).map(element => element.textContent));
        expect(clippedLinks, `${target.name} evidence links`).toEqual([]);
      }
      if (target.name === 'run') {
        const clipped = await page.locator('.check-label, .check-evidence, .link-strip a').evaluateAll((elements, narrow) => {
          return elements.flatMap(element => {
            const isLink = element.matches('a');
            const container = element.closest(isLink ? '.link-strip' : '.check-item')!;
            const bounds = container.getBoundingClientRect();
            const card = element.closest('.card')!.getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const own = element.getBoundingClientRect();
            const outside = [own].some(rect =>
              rect.left < Math.max(bounds.left, card.left) - 1 || rect.right > Math.min(bounds.right, card.right) + 1 ||
              rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1) ||
              ((isLink || narrow) && [...range.getClientRects()].some(rect =>
                rect.left < own.left - 1 || rect.right > own.right + 1 || rect.top < own.top - 1 || rect.bottom > own.bottom + 1));
            return outside ? [element.textContent] : [];
          });
        }, width <= 600);
        expect.soft(clipped, `${width}px labels, evidence and links stay inside their rows and cards`).toEqual([]);
        if (width <= 600 && clipped.length === 0) {
          const evidence = page.locator('.check-evidence').first();
          await evidence.scrollIntoViewIfNeeded();
          const positionInRow = () => evidence.evaluate(element => {
            const bounds = element.getBoundingClientRect();
            const row = element.closest('.check-item')!.getBoundingClientRect();
            return { left: bounds.left - row.left, top: bounds.top - row.top, width: bounds.width, height: bounds.height };
          });
          const before = await positionInRow();
          await evidence.hover();
          await expect(evidence).toHaveCSS('position', 'static');
          expect.soft(await positionInRow(), 'hover keeps evidence in the document flow').toEqual(before);
          await page.mouse.move(0, 0);
        }
        const leaseLink = page.locator('.link-strip a').filter({ hasText: 'worktree.lease.created' }).first();
        await expect(leaseLink).toHaveCount(1);
        const href = await leaseLink.getAttribute('href');
        const eventId = new URL(href!, page.url()).searchParams.get('event') ?? href!.replace(/^#audit-/, '');
        await leaseLink.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Tab');
        await expect(leaseLink).toBeFocused();
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(`${server.url}/advanced/runs/run_1/audit?event=${encodeURIComponent(eventId)}`);
        await expect(page.getByRole('link', { name: 'Audit', exact: true })).toHaveAttribute('aria-current', 'page');
        const event = page.locator('.audit-item').filter({ has: page.getByText(eventId, { exact: true }) });
        await expect(event).toBeFocused();
        await expect(event).toBeInViewport();
        await expect(event.locator('.audit-type')).toHaveText('worktree.lease.created');
        await expect(event.locator('pre')).toContainText('"worktreePath"');
        await expect(event.locator('pre')).toContainText('"nodeId": "node_1"');
        expect(await event.evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
        await page.goBack();
        await expect(page).toHaveURL(`${server.url}/advanced/runs/run_1`);
        await expect(leaseLink).toBeVisible();
      }
      // The run table intentionally scrolls horizontally on narrow screens.
      // Prove its action column can be brought into view before measuring.
      if (target.name === 'runs') await page.locator('.run-controls button').first().scrollIntoViewIfNeeded();
      const layout = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll('.run-controls button')].map(el => el.getBoundingClientRect()).filter(r => r.width && r.height);
        const overlap = buttons.some((r, i) => buttons.slice(i + 1).some(s => Math.min(r.right, s.right) - Math.max(r.left, s.left) > 1 && Math.min(r.bottom, s.bottom) - Math.max(r.top, s.top) > 1));
        return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, controlsOverlap: overlap,
          controlsOutside: buttons.some(r => r.left < -1 || r.right > innerWidth + 1) };
      });
      expect(layout.scrollWidth, target.name).toBeLessThanOrEqual(width + 1);
      expect(layout.controlsOverlap, target.name).toBe(false);
      expect(layout.controlsOutside, target.name).toBe(false);
      geometry.push({ page: target.name, ...layout });
      await page.evaluate(() => window.scrollTo(0, 0));
      await page.screenshot({ path: info.outputPath(`${width}-${target.name}.png`), fullPage: true, animations: 'disabled' });
    }
    expect(errors).toEqual([]);
    await info.attach('geometry', { body: JSON.stringify(geometry, null, 2), contentType: 'application/json' });
  });
}
