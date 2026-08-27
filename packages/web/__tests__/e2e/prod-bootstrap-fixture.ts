import { test as base, expect } from '@playwright/test';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

// F7-P0-01: a fixture that does NOT monkeypatch window.fetch to inject the
// session token. shared-fixture.ts injects the token before every page load,
// which masks the production bootstrap — a test using it would pass even with
// the token bootstrap broken (a fake test). This fixture starts the same
// server + project but leaves auth entirely to the real client bootstrap
// (`#token=` fragment → sessionStorage), so the test exercises exactly what a
// real `tekon ui` user gets.

type FixtureProject = Awaited<ReturnType<typeof createWebFixtureProject>>;

export interface ProdBootstrapFixtures {
  fixture: FixtureProject;
  server: RunningWebServer;
}

export const test = base.extend<ProdBootstrapFixtures>({
  fixture: async ({}, use) => {
    const fixture = await createWebFixtureProject();
    await use(fixture);
    fixture.cleanup();
  },

  server: async ({ fixture }, use) => {
    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: true,
    });
    await server.listen();
    await use(server);
    await server.close();
  },
});

export { expect };
