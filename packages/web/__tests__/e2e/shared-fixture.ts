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

// Inject the session token into the browser before each page loads.
// The RPC client reads this token for authenticated read/write endpoints.
test.beforeEach(async ({ page, fixture, server }) => {
  await page.addInitScript(
    ({ token }) => {
      // Intercept the rpc-client module's setRpcSessionToken by
      // monkey-patching the global fetch to inject the token header.
      const originalFetch = window.fetch;
      window.fetch = function patchedFetch(
        input: RequestInfo | URL,
        init?: RequestInit,
      ) {
        if (
          typeof input === 'string' &&
          input.includes('/api/rpc') &&
          token
        ) {
          const headers = new Headers(init?.headers);
          headers.set('x-session-token', token);
          init = { ...init, headers };
        }
        return originalFetch.call(window, input, init);
      };
    },
    { token: fixture.sessionToken },
  );
});

export { expect };
