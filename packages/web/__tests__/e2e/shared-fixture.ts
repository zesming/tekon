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
