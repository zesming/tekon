import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

describe('project.run mode policy', () => {
  it('rejects dsh-headless before creating a governed workflow run', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.project.run({
        demandText: 'This combination cannot produce workflow artifacts.',
        template: 'standard-delivery',
        agent: 'dsh-headless',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('dsh-headless 仅支持 goal'),
    });
  });

  it('rejects goal inputs that still request workflow or delivery behavior', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.project.run({
        demandText: 'Goal must not silently ignore a template.',
        mode: 'goal',
        template: 'bugfix',
        agent: 'mock',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: '--goal 模式下不能同时指定 --template',
    });

    await expect(
      api.project.run({
        demandText: 'Goal cannot auto-prepare a delivery.',
        mode: 'goal',
        profile: 'autonomous-delivery',
        agent: 'mock',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      message: expect.stringContaining('不支持 autonomous-delivery'),
    });
  });
});
