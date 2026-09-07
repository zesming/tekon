import { join } from 'node:path';

import { computeRunPlanDigest, openTekonDatabase } from '@tekon/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

describe('project.run plan digest validation (P1-UX-01 / P1-PRODUCT-02 / A-web)', () => {
  it('accepts and persists the exact plan that passed validation', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const plan = await api.workflow.plan({
      template: 'project-feature',
      agent: 'mock',
      mode: 'workflow',
      allowDirtyBase: true,
      timeoutMs: 3600000,
    });

    const result = await api.project.run({
      demandText: 'Implement new search filter',
      template: 'project-feature',
      agent: 'mock',
      mode: 'workflow',
      token: fixture.sessionToken,
      allowDirtyBase: true,
      timeoutMs: 3600000,
      planDigest: plan.digest,
    });

    expect(result.run).toBeDefined();
    expect(result.run.id).toBeDefined();
    expect(result.sessionId).toBeDefined();

    const db = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    try {
      const row = db
        .prepare(
          'select plan_digest, plan_snapshot from workflow_instances where id = ?',
        )
        .get(result.run.id) as
        | { plan_digest: string | null; plan_snapshot: string | null }
        | undefined;
      expect(row?.plan_digest).toBe(plan.digest);
      expect(row?.plan_snapshot).toBeTruthy();
      const snapshot = JSON.parse(row!.plan_snapshot!);
      expect(snapshot.digestVersion).toBe(3);
      expect(snapshot.mode).toBe('workflow');
      expect(snapshot.template.id).toBe('project-feature');
      expect(computeRunPlanDigest(snapshot)).toBe(plan.digest);
      expect(plan).not.toHaveProperty('template');
    } finally {
      db.close();
    }
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

  it('rejects a workflow run when planDigest is omitted', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.project.run({
        demandText: 'Run without planDigest (must be rejected)',
        template: 'project-feature',
        agent: 'mock',
        mode: 'workflow',
        token: fixture.sessionToken,
        allowDirtyBase: true,
      }),
    ).rejects.toThrow(/PLAN_DIGEST_REQUIRED/);
  });

  it('rejects a supplied incorrect goal digest but preserves the old no-preview API', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(api.project.run({
      demandText: 'Goal mode run',
      mode: 'goal',
      agent: 'mock',
      token: fixture.sessionToken,
      allowDirtyBase: true,
      planDigest: 'any-arbitrary-digest',
    })).rejects.toThrow(/PLAN_DIGEST_MISMATCH/);

    const resultWithoutDigest = await api.project.run({
      demandText: 'Goal mode run without digest',
      mode: 'goal',
      agent: 'mock',
      token: fixture.sessionToken,
      allowDirtyBase: true,
    });

    expect(resultWithoutDigest.run).toBeDefined();
    expect(resultWithoutDigest.sessionId).toBeDefined();
  });

  it('verifies allowDirtyBase and timeoutMs participate in digest calculation end-to-end', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const planA = await api.workflow.plan({
      template: 'project-feature',
      agent: 'mock',
      mode: 'workflow',
      allowDirtyBase: true,
      timeoutMs: 1000,
    });

    const planB = await api.workflow.plan({
      template: 'project-feature',
      agent: 'mock',
      mode: 'workflow',
      allowDirtyBase: true,
      timeoutMs: 2000,
    });

    expect(planA.digest).not.toBe(planB.digest);

    await expect(
      api.project.run({
        demandText: 'Mismatch timeout run',
        template: 'project-feature',
        agent: 'mock',
        mode: 'workflow',
        token: fixture.sessionToken,
        allowDirtyBase: true,
        timeoutMs: 2000,
        planDigest: planA.digest,
      }),
    ).rejects.toThrow(/PLAN_DIGEST_MISMATCH/);
  });
});
