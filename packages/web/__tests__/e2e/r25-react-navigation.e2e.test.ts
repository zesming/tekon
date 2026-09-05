import { test as base, expect } from './shared-fixture.js';
import { createWebServer } from '../../src/server/http.js';
import { credentialStatus } from './helpers/locators.js';

// 此矩阵验证真实 React 生命周期与生产 hook/组件，不替代生产构建的导航旅程。
// Vite 仅让测试访问 App 导出的同一 Router 实例，以精确延迟导航 Promise；
// 不修改生产代码或模拟 React hooks，也不新增 DOM 测试依赖。
const test = base.extend({
  server: async ({ fixture }, use) => {
    const server = await createWebServer({ projectRoot: fixture.projectRoot, port: 0, vite: true });
    await server.listen();
    try { await use(server); } finally { await server.close(); }
  },
});

declare global {
  interface Window {
    __r25DeferredNavigation?: {
      calls: number;
      settle(outcome: 'resolve' | 'reject'): void;
      leave(): Promise<void>;
    };
  }
}

const DEMAND = '保留导航等待期间的原需求 A';
const CHANGED_DEMAND = '用户后来编辑的新需求 B';
const LOCAL_WARNING = '请求已受理，但浏览器请求记录更新或页面跳转未完成';

for (const action of ['none', 'edit-cycle', 'new-intent', 'token-cycle', 'unmount'] as const) {
  for (const outcome of ['resolve', 'reject'] as const) {
    test(`真实 React deferred navigation ${action} → ${outcome} keeps current form ownership`, async ({ page, server, fixture }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', error => { pageErrors.push(error.message); });
      // 本文件显式建立真实 origin；不能依赖共享模块顶层 beforeEach
      // 在其他测试文件已导入该模块后，仍为本文件注册启动钩子。
      await page.goto(`${server.url}/`);
      await expect(credentialStatus(page, 'valid')).toBeVisible();
      await expect(page).not.toHaveURL(/token=/u);
      const scopeResponse = await page.request.post(`${server.url}/api/rpc`, {
        data: { path: 'project.admissionIntent', input: { token: fixture.sessionToken } },
        headers: { 'sec-fetch-site': 'same-origin', 'x-session-token': fixture.sessionToken },
      });
      expect(scopeResponse.status()).toBe(200);
      const scope = (await scopeResponse.json()).result.scope as string;
      expect(scope).toMatch(/^[a-f0-9]{64}$/);
      await page.evaluate((scope) => {
        sessionStorage.setItem(`tekon.run-admissions.v1.${encodeURIComponent(scope)}`, JSON.stringify([
          { scope, requestId: 'r25-react-older-unknown', fingerprint: 'older-fingerprint', state: 'unknown' },
        ]));
      }, scope);

      let postCount = 0;
      await page.route('**/api/rpc', async route => {
        const body = route.request().postDataJSON() as { path: string; input: { requestId: string } };
        if (body.path !== 'project.run') return route.continue();
        postCount++;
        // 回执用于 React 边界，不声称创建真实 Run；生产 I/O 测试另验 SQLite。
        return route.fulfill({ json: { result: {
          requestId: body.input.requestId, admissionState: 'accepted', replayed: false,
          sessionId: 'session-r25-react-navigation', jobId: 'job-r25-react-navigation',
          run: {
            id: 'run-r25-react-navigation', projectId: 'project-r25-react', demandId: 'demand-r25-react',
            demandTitle: DEMAND, provider: 'mock', status: 'running', currentNodeId: null,
            createdAt: '2026-09-05T00:00:00.000Z', updatedAt: '2026-09-05T00:00:00.000Z', filesState: 'ready',
          },
        } } });
      });
      const [loadedScope] = await Promise.all([
        page.waitForResponse(response => response.url().includes('/api/rpc') &&
          response.request().postDataJSON()?.path === 'project.admissionIntent' &&
          !response.request().postDataJSON()?.input.run),
        // goto 同一路径只新增 #token 会成为同文档导航，不会重读刚写入的账本。
        page.reload(),
      ]);
      expect((await loadedScope.json()).result.scope).toBe(scope);
      const ledgerState = await page.evaluate(scope => sessionStorage.getItem(`tekon.run-admissions.v1.${encodeURIComponent(scope)}`), scope);
      expect(ledgerState).toContain('r25-react-older-unknown');
      await expect(page.getByText('r25-react-older-unknown', { exact: true })).toBeVisible({ timeout: 2_000 });
      await page.evaluate(async () => {
        const modulePath = '/src/client/App.tsx';
        const { router } = await import(modulePath);
        const originalNavigate = router.navigate.bind(router);
        let resolve!: () => void;
        let reject!: (error: Error) => void;
        const pending = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        let settled = false;
        const probe = {
          calls: 0,
          settle(outcome: 'resolve' | 'reject') {
            if (settled) return;
            settled = true;
            if (outcome === 'resolve') resolve();
            else reject(new Error('PRIVATE_R25_DEFERRED_NAVIGATION'));
          },
          leave: () => originalNavigate('/advanced'),
        };
        router.navigate = (to: string | number, options?: Record<string, unknown>) => {
          if (typeof to === 'string' && to.startsWith('/sessions/')) {
            probe.calls++;
            return pending;
          }
          return originalNavigate(to, options);
        };
        window.__r25DeferredNavigation = probe;
      });

      const input = page.getByLabel('新建受控交付任务');
      const submit = page.getByRole('button', { name: /^(启动受控交付|正在创建交付…)$/u });
      await input.fill(DEMAND);
      await submit.click();
      try {
        // 证明修改的是此组件实际使用的 Router 实例，不是另建的影子路由。
        await expect.poll(() => page.evaluate(() => window.__r25DeferredNavigation?.calls)).toBe(1);
        await expect(input).toHaveValue(DEMAND, { timeout: 2_000 });
        await expect(submit).toBeDisabled();
        expect(postCount).toBe(1);

        if (action === 'edit-cycle') {
          await input.fill(CHANGED_DEMAND);
          await input.fill(DEMAND);
        } else if (action === 'new-intent') {
          await input.fill(CHANGED_DEMAND);
          await page.getByRole('button', { name: '明确新建另一个任务', exact: true }).click();
          await expect(page.getByText('已选择另建任务；下次提交将使用新请求身份，旧请求仍可查询。')).toBeVisible();
        } else if (action === 'token-cycle') {
          await page.evaluate(() => { location.hash = 'token=r25-react-different-token'; });
          await expect(credentialStatus(page, 'invalid')).toBeVisible();
          await page.evaluate(token => { location.hash = new URLSearchParams({ token }).toString(); }, fixture.sessionToken);
          await expect(credentialStatus(page, 'valid')).toBeVisible();
        } else if (action === 'unmount') {
          await page.evaluate(async () => { await window.__r25DeferredNavigation!.leave(); });
          await expect(page).toHaveURL(/\/advanced$/);
          await expect(input).toHaveCount(0);
        }

        await page.evaluate(outcome => { window.__r25DeferredNavigation!.settle(outcome); }, outcome);
        // 让 Promise continuation 和 React 更新完成，检查旧回调没有迟到发布。
        await page.evaluate(async () => {
          await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        });
        if (action !== 'unmount') {
          await expect(input).toHaveValue(action === 'new-intent' ? CHANGED_DEMAND : DEMAND);
          await expect(submit).toBeEnabled();
        }
        if (action === 'none' && outcome === 'reject') {
          await expect(page.getByRole('alert')).toContainText(LOCAL_WARNING);
          await expect(page.getByRole('link', { name: '观察原会话' })).toHaveAttribute('href', '/sessions/session-r25-react-navigation');
        } else {
          await expect(page.getByText(LOCAL_WARNING, { exact: false })).toHaveCount(0);
        }
        expect(pageErrors).toEqual([]);
        expect(postCount).toBe(1);
        expect(await page.evaluate(() => window.__r25DeferredNavigation?.calls)).toBe(1);
      } finally {
        await page.evaluate(() => window.__r25DeferredNavigation?.settle('resolve'));
      }
    });
  }
}
