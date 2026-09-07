import { join } from 'node:path';
import { createSessionEventStore, createWriteQueue, openTekonDatabase } from '@tekon/core';
import { test, expect } from './shared-fixture.js';

// 这里检查真实页面如何呈现安全 RPC 投影；持久记录的分类正确性由 API/Core 验收负责。
for (const width of [320, 390, 700, 1440]) {
  test(`R24 ${width}px: Run and Session retain accepted recovery and explain historical binding`, async ({ page, server, fixture }, info) => {
    await page.setViewportSize({ width, height: 1000 });
    const db = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
    let sessionId: string;
    try {
      const store = createSessionEventStore(db, createWriteQueue());
      const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);
      const session = await store.createSession({ workspaceId: workspace.id, runId: 'run_1', profile: 'human-web', title: 'R24 已受理运行与历史检查说明' });
      sessionId = session.id;
    } finally {
      db.close();
    }
    await page.route('**/api/rpc', async (route) => {
      const path = route.request().postDataJSON().path;
      if (path !== 'review.get' && path !== 'session.get') return route.continue();
      const response = await route.fetch();
      const payload = await response.json();
      const target = path === 'session.get' ? payload.result.session : payload.result;
      Object.assign(target, { admissionState: 'recovery-required', filesState: 'recovery_required', executionBinding: 'legacy-unbound' });
      return route.fulfill({ json: payload });
    });
    for (const [surface, path] of [['session', `/sessions/${sessionId}`], ['run', '/advanced/runs/run_1']] as const) {
      await page.goto(`${server.url}${path}`);
      const recovery = page.getByTestId('admission-readiness');
      const binding = page.getByTestId('execution-binding-notice');
      await expect(recovery).toContainText('已受理，等待目录恢复');
      await expect(recovery).toContainText('任务尚未执行');
      await expect(binding).toContainText('历史计划未记录仓库命令绑定');
      await expect(binding).toHaveAttribute('data-binding-state', 'legacy-unbound');
      await expect(page.getByRole('button', { name: '暂停运行' })).toHaveCount(0);
      const geometry = await binding.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, viewport: innerWidth, documentOverflow: document.documentElement.scrollWidth > innerWidth + 1, clipped: element.scrollWidth > element.clientWidth + 1 };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(-1);
      expect(geometry.right).toBeLessThanOrEqual(geometry.viewport + 1);
      expect(geometry.documentOverflow).toBe(false);
      expect(geometry.clipped).toBe(false);
      await page.screenshot({ path: info.outputPath(`r24-${width}-${surface}-recovery-binding.png`), fullPage: true, animations: 'disabled' });
    }
  });
}
