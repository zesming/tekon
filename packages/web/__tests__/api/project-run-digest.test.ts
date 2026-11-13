import { join } from 'node:path';
import { rmSync, writeFileSync } from 'node:fs';

import {
  computeRunPlanDigest,
  FALLBACK_DEFAULT_AGENT,
  openTekonDatabase,
} from '@tekon/core';
import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';
import { webRunEnvelope } from '../../src/server/api/admission-envelope.js';

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

// PD-24 / T-16: when the Web client omits `agent`, preview and admission must
// resolve the same repo-configured default so one digest validates both. The
// core resolver has direct unit tests; here we lock the Web router wiring and
// the end-to-end digest parity.
describe('omitted agent resolves the repo default with digest parity (PD-24 / T-16)', () => {
  it('uses a configured defaultAgent in preview and admission and accepts one digest', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    writeFileSync(
      join(fixture.projectRoot, '.tekon', 'config.yaml'),
      'defaultAgent: mock\n',
    );
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    // Preview with no agent: the workflow router lets captureRunPlan resolve
    // the configured default itself.
    const omittedPreview = await api.workflow.plan({
      template: 'project-feature',
      mode: 'workflow',
      allowDirtyBase: true,
      timeoutMs: 3600000,
    });
    expect(omittedPreview.agent).toBe('mock');

    // Naming the same agent explicitly must hash byte-for-byte identically.
    const explicitPreview = await api.workflow.plan({
      template: 'project-feature',
      agent: 'mock',
      mode: 'workflow',
      allowDirtyBase: true,
      timeoutMs: 3600000,
    });
    expect(explicitPreview.digest).toBe(omittedPreview.digest);

    // Admission with no agent must accept the omitted-agent preview digest.
    const result = await api.project.run({
      demandText: 'Run relying on the configured default agent',
      template: 'project-feature',
      mode: 'workflow',
      token: fixture.sessionToken,
      allowDirtyBase: true,
      timeoutMs: 3600000,
      planDigest: omittedPreview.digest,
    });
    expect(result.run.id).toBeDefined();

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
      expect(row?.plan_digest).toBe(omittedPreview.digest);
      const snapshot = JSON.parse(row!.plan_snapshot!);
      expect(snapshot.agent).toBe('mock');
      expect(computeRunPlanDigest(snapshot)).toBe(omittedPreview.digest);
    } finally {
      db.close();
    }
  });

  it('falls back to the built-in default without a config and keeps admission parity', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    // The fixture ships a config.yaml with an explicit defaultAgent; removing
    // it reproduces a repo that never configured a default.
    rmSync(join(fixture.projectRoot, '.tekon', 'config.yaml'));
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const omittedPreview = await api.workflow.plan({
      template: 'project-feature',
      mode: 'workflow',
      allowDirtyBase: true,
    });
    expect(omittedPreview.agent).toBe(FALLBACK_DEFAULT_AGENT);

    // Explicitly naming the fallback agent must produce the same digest.
    const fallbackPreview = await api.workflow.plan({
      template: 'project-feature',
      agent: FALLBACK_DEFAULT_AGENT,
      mode: 'workflow',
      allowDirtyBase: true,
    });
    expect(fallbackPreview.digest).toBe(omittedPreview.digest);

    // The admission envelope normalizes an omitted agent to the same fallback
    // before hashing, independent of the preview call path.
    const envelope = webRunEnvelope(fixture.projectRoot, {
      demandText: 'Fallback agent run',
      template: 'project-feature',
      mode: 'workflow',
      allowDirtyBase: true,
    });
    expect(envelope.agent).toBe(FALLBACK_DEFAULT_AGENT);

    // A digest captured for a different agent (mock) cannot be admitted when
    // the agent is omitted: admission re-captures with the fallback and fails
    // closed before any provider process starts.
    const mockPreview = await api.workflow.plan({
      template: 'project-feature',
      agent: 'mock',
      mode: 'workflow',
      allowDirtyBase: true,
    });
    await expect(
      api.project.run({
        demandText: 'Run whose omitted agent must not match a mock digest',
        template: 'project-feature',
        mode: 'workflow',
        token: fixture.sessionToken,
        allowDirtyBase: true,
        planDigest: mockPreview.digest,
      }),
    ).rejects.toThrow(/PLAN_DIGEST_MISMATCH/);
  });
});

// A malformed .tekon/config.yaml is a user-fixable input error: both the
// preview and admission surfaces must answer 400 (BAD_REQUEST), not a generic
// 500, while still failing closed.
describe('malformed repo config is a BAD_REQUEST on every entry path', () => {
  const malformedConfigs: Array<{ name: string; contents: string }> = [
    { name: 'invalid YAML syntax', contents: 'defaultAgent: [unclosed\n' },
    { name: 'unsupported defaultAgent value', contents: 'defaultAgent: not-a-real-agent\n' },
  ];

  for (const { name, contents } of malformedConfigs) {
    it(`maps ${name} to BAD_REQUEST in workflow.plan`, async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      writeFileSync(join(fixture.projectRoot, '.tekon', 'config.yaml'), contents);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });
      cleanupTasks.push(() => api.close());

      await expect(
        api.workflow.plan({
          template: 'project-feature',
          mode: 'workflow',
          allowDirtyBase: true,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it(`maps ${name} to BAD_REQUEST in project.run`, async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      writeFileSync(join(fixture.projectRoot, '.tekon', 'config.yaml'), contents);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });
      cleanupTasks.push(() => api.close());

      await expect(
        api.project.run({
          demandText: 'Run against a malformed repo config',
          template: 'project-feature',
          mode: 'workflow',
          token: fixture.sessionToken,
          allowDirtyBase: true,
          planDigest: 'any-digest-fails-after-config-resolution',
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });
  }
});
