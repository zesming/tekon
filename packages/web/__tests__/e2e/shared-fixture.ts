import { test as base, expect } from '@playwright/test';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

type FixtureProject = Awaited<ReturnType<typeof createWebFixtureProject>>;

export interface SharedFixtures {
  fixture: FixtureProject;
  server: RunningWebServer;
}

export const test = base.extend<SharedFixtures>({
  fixture: async ({}, use) => {
    const fixture = await createWebFixtureProject();
    await use(fixture);
    fixture.cleanup();
  },

  server: async ({ fixture }, use) => {
    // Exercise the production static-server path. The package test:e2e script
    // builds the client first, so route assertions are never coupled to Vite's
    // dev-only on-demand transform timing.
    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
    });
    await server.listen();
    await use(server);
    await server.close();
  },

  // Carry the session token on every cross-document navigation to this server.
  //
  // The production bootstrap resolves the token in this order (session-
  // bootstrap.ts): the `#token=` URL fragment first, then a sessionStorage
  // fallback. `main.tsx` reads it synchronously before the first render and
  // seeds the RPC/SSE client, so the first-paint authenticated request already
  // carries `x-session-token`.
  //
  // The flaky failure this fixes: `beforeEach` navigates to `/#token=` (which
  // persists the token to sessionStorage in an AuthProvider effect), then each
  // journey does a *second* `page.goto` to a fresh document. That new document
  // reads sessionStorage synchronously in `main.tsx` — but the previous
  // document's async sessionStorage write is not guaranteed to have committed
  // before the navigation tears it down. When it hasn't, the first-paint RPC
  // leaves with a null token → 401 → the app renders an auth-error page and the
  // asserted content never appears. A retry (with sessionStorage now populated)
  // passes, which `failOnFlakyTests` correctly reports as a CI failure.
  //
  // Injecting `#token=` on the navigation makes `main.tsx` hit the fragment
  // branch synchronously on that same document, so it never depends on the
  // cross-navigation sessionStorage handoff. Only the initial cross-document
  // `page.goto` needs this: SPA (React Router) navigations and `page.reload()`
  // reuse the already-committed sessionStorage of a running document and never
  // route through this wrapper — that is intentional and safe.
  page: async ({ page, fixture, server }, use) => {
    const origin = new URL(server.url).origin;
    const rawGoto = page.goto.bind(page);
    page.goto = (async (url, options) => {
      const target = new URL(url, server.url);
      if (target.origin === origin && !target.hash.includes('token=')) {
        target.hash = `token=${encodeURIComponent(fixture.sessionToken)}`;
      }
      return rawGoto(target.toString(), options);
    }) as typeof page.goto;
    await use(page);
  },
});

// Establish the same connected state as a real `tekon ui` launch. Seeding
// sessionStorage before the first real origin proved unreliable in CI: the
// first attempt could render with an empty AuthProvider while a retry happened
// to inherit the expected state. Navigate through the production #token
// bootstrap instead, then prove the visible credential and URL cleanup before
// each business journey starts. Dedicated bootstrap tests keep the deeper
// no-401, refresh, Referer and same-tab hash assertions.
test.beforeEach(async ({ page, fixture, server }) => {
  const fragment = new URLSearchParams({
    token: fixture.sessionToken,
  }).toString();
  await page.goto(`${server.url}/#${fragment}`);
  await expect(page.getByLabel('Session token')).toHaveValue(
    fixture.sessionToken,
    { timeout: 15_000 },
  );
  await expect(page).not.toHaveURL(/token=/u);
});

export { expect };
