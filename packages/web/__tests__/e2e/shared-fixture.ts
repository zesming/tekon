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

const SESSION_TOKEN_STORAGE_KEY = 'tekon.sessionToken';

export const test = base.extend<SharedFixtures>({
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

// Use the same tab-scoped bootstrap channel as production. The old fixture
// monkey-patched window.fetch and silently injected x-session-token, which let
// business E2E bypass main.tsx -> AuthProvider -> RPC/SSE credential wiring.
// Production-bootstrap tests still own the fragment capture/cleanup assertions;
// shared business tests seed sessionStorage, then warm the real app shell once
// so route assertions do not double as cold Vite-compilation timing tests.
test.beforeEach(async ({ page, fixture, server }) => {
  await page.addInitScript(
    ({ storageKey, token }) => {
      window.sessionStorage.setItem(storageKey, token);
    },
    {
      storageKey: SESSION_TOKEN_STORAGE_KEY,
      token: fixture.sessionToken,
    },
  );

  await page.goto(server.url);
  await expect(page.locator('#root')).not.toBeEmpty({ timeout: 30_000 });
});

export { expect };
