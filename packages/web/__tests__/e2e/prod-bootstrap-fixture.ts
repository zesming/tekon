import { test as base, expect } from '@playwright/test';

import { createWebFixtureProject } from '../fixtures/project.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

// Production-bootstrap fixture: no sessionStorage seed and no request
// interception. Authentication is left entirely to the real client bootstrap
// (`#token=` fragment -> sessionStorage), and the production static-server path
// serves the same built assets a real `tekon ui` launch uses.

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
    });
    await server.listen();
    await use(server);
    await server.close();
  },
});

export { expect };
