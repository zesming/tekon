import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

describe('project.run plan digest validation (P1-UX-01 / P1-PRODUCT-02)', () => {
  it('accepts a run when planDigest matches the projected plan', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const plan = await api.workflow.plan({
      template: 'project-feature',
      agent: 'mock',
      mode: 'workflow',
    });

    const planDigest = plan.digest ?? 'fallback-digest';

    const result = await api.project.run({
      demandText: 'Implement new search filter',
      template: 'project-feature',
      agent: 'mock',
      mode: 'workflow',
      token: fixture.sessionToken,
      allowDirtyBase: true,
      planDigest,
    });

    expect(result.run).toBeDefined();
    expect(result.run.id).toBeDefined();
    expect(result.sessionId).toBeDefined();
  });

  it('rejects a run when planDigest does not match the projected plan', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.project.run({
        demandText: 'Tampered run demand',
        template: 'project-feature',
        agent: 'mock',
        mode: 'workflow',
        token: fixture.sessionToken,
        allowDirtyBase: true,
        planDigest: 'mismatched-digest-value-12345',
      }),
    ).rejects.toThrow(/PLAN_DIGEST_MISMATCH/);
  });

  it('maintains status quo when planDigest is omitted', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: 'Run without planDigest (CLI or legacy)',
      template: 'project-feature',
      agent: 'mock',
      mode: 'workflow',
      token: fixture.sessionToken,
      allowDirtyBase: true,
    });

    expect(result.run).toBeDefined();
    expect(result.run.id).toBeDefined();
  });

  it('does not validate planDigest in goal mode', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: 'Goal mode run',
      mode: 'goal',
      agent: 'mock',
      token: fixture.sessionToken,
      allowDirtyBase: true,
      planDigest: 'any-arbitrary-digest',
    });

    expect(result.run).toBeDefined();
    expect(result.sessionId).toBeDefined();
  });
});
