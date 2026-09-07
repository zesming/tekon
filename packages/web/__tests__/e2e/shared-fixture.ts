import { test as base, expect } from '@playwright/test';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';
import { credentialStatus } from './helpers/locators.js';

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

  // Business journeys use page.goto() to launch many deep routes as fresh
  // documents. Treat each same-origin hard navigation as a fresh authenticated
  // `tekon ui` launch by carrying the production #token fragment. This is an
  // explicit test-launch policy, not evidence that sessionStorage recovery was
  // exercised on every journey; the dedicated prod-bootstrap suite owns the
  // refresh/sessionStorage, URL cleanup and Referer assertions.
  //
  // Without this policy, cold CI runs intermittently reach the new document
  // before the previous document's bootstrap state is available and render the
  // 401 page; retry then passes. failOnFlakyTests correctly rejects that result.
  page: async ({ page, fixture, server }, use) => {
    const origin = new URL(server.url).origin;
    const rawGoto = page.goto.bind(page);
    page.goto = (async (url, options) => {
      const target = new URL(url, server.url);
      if (target.origin === origin) {
        const hash = new URLSearchParams(target.hash.slice(1));
        if (!hash.has('token')) {
          hash.set('token', fixture.sessionToken);
          target.hash = hash.toString();
        }
      }
      return rawGoto(target.toString(), options);
    }) as typeof page.goto;
    await use(page);
  },
});

// Establish the same credential-configured state as a real `tekon ui` launch,
// then prove that the credential is visible and the fragment is removed before
// each business journey starts. The page fixture above also authenticates every
// later hard route launch; SPA navigation and page.reload() do not use it.
test.beforeEach(async ({ page, fixture, server }) => {
  const fragment = new URLSearchParams({
    token: fixture.sessionToken,
  }).toString();
  await page.goto(`${server.url}/#${fragment}`);
  await expect(credentialStatus(page, 'valid')).toBeVisible({
    timeout: 15_000,
  });
  await expect(page).not.toHaveURL(/token=/u);
});

export { expect };
