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

// Use the same tab-scoped bootstrap channel as production. The old fixture
// monkey-patched window.fetch and silently injected x-session-token, which let
// business E2E bypass main.tsx -> AuthProvider -> RPC/SSE credential wiring.
// Dedicated production-bootstrap tests still own fragment capture/cleanup and
// bare-URL manual recovery; shared business tests start in the normal connected
// state and assert the real visible token/auth scope.
test.beforeEach(async ({ page, fixture }) => {
  await page.addInitScript(
    ({ storageKey, token }) => {
      window.sessionStorage.setItem(storageKey, token);
    },
    {
      storageKey: SESSION_TOKEN_STORAGE_KEY,
      token: fixture.sessionToken,
    },
  );
});

export { expect };
