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
});

// Establish the same connected state as a real `tekon ui` launch. `main.tsx`
// resolves and persists the fragment token synchronously before the first React
// render, so later hard navigations must authenticate from the production
// sessionStorage fallback without any test-only `page.goto` rewriting.
// Dedicated bootstrap tests keep the deeper first-paint, refresh, Referer and
// same-tab hash assertions.
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
