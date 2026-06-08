import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';
import { resolveProjectRoot } from '../../src/server/project-context.js';
import { createWebServer } from '../../src/server/http.js';

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('web project context', () => {
  it('refuses to start without an explicit project root', async () => {
    expect(() => resolveProjectRoot({ env: {} })).toThrow(
      /DONKEY_PROJECT_ROOT/,
    );

    await expect(createWebServer({ env: {}, vite: false })).rejects.toThrow(
      /DONKEY_PROJECT_ROOT/,
    );
  });

  it('scopes project reads to the explicit project root', async () => {
    const fixture = await createWebFixtureProject({
      includeOutOfScopeProject: true,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const projects = await api.project.list();
    expect(projects.map((project) => project.id)).toEqual([
      'project_0',
      'project_1',
    ]);
    await expect(
      api.project.detail({ projectId: 'project_1' }),
    ).resolves.toMatchObject({
      runs: [
        expect.objectContaining({ id: 'run_1' }),
        expect.objectContaining({ id: 'run_0' }),
      ],
    });

    await expect(
      api.project.detail({ projectId: 'project_escaped' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await api.close();
  });
});
