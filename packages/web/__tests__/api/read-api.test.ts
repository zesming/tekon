import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('web read API', () => {
  it('returns overview, artifacts, gates, audit, roles, and workflows', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const overview = await api.project.overview();
    expect(overview.project).toMatchObject({ id: 'project_1' });
    expect(overview.latestRun).toMatchObject({ id: 'run_1' });
    expect(overview.counts).toMatchObject({
      artifacts: 1,
      gates: 1,
      audit: 1,
      pendingApprovals: 1,
      roles: 1,
      workflows: 1,
    });

    await expect(api.artifact.list({ runId: 'run_1' })).resolves.toMatchObject({
      artifacts: [expect.objectContaining({ id: 'artifact_1' })],
    });
    await expect(api.gate.list({ runId: 'run_1' })).resolves.toMatchObject({
      pendingDecisions: [
        expect.objectContaining({
          id: 'decision_1',
          context: expect.objectContaining({
            exactCommand: 'donkey run --template standard-feature --agent mock',
            riskLabel: 'high',
            nodeRole: 'reviewer',
            gate: expect.objectContaining({ id: 'gate_1', type: 'human' }),
          }),
        }),
      ],
    });
    await expect(api.audit.list({ runId: 'run_1' })).resolves.toMatchObject({
      verification: { valid: true },
      events: [
        expect.objectContaining({
          type: 'human.decision.pending',
          nodeId: 'node_1',
          gateId: 'gate_1',
          role: 'reviewer',
          hash: expect.any(String),
        }),
      ],
    });
    await expect(api.review.get({ runId: 'run_1' })).resolves.toMatchObject({
      readiness: expect.objectContaining({
        ready: false,
        checks: expect.arrayContaining([
          expect.objectContaining({ id: 'workflow-passed', passed: false }),
        ]),
      }),
      artifacts: [
        expect.objectContaining({
          id: 'artifact_1',
          content: expect.objectContaining({
            exists: true,
            content: expect.stringContaining('Review report body'),
          }),
        }),
      ],
      gates: [
        expect.objectContaining({
          id: 'gate_1',
          output: expect.objectContaining({
            content: expect.stringContaining('human approval is required'),
          }),
        }),
      ],
      delivery: expect.objectContaining({
        package: expect.objectContaining({
          content: expect.stringContaining('PR Preparation'),
        }),
        prBody: expect.objectContaining({
          content: expect.stringContaining('Add dashboard'),
        }),
      }),
    });
    await expect(
      api.audit.list({ runId: 'run_1', nodeId: 'node_1', gateId: 'gate_1' }),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ id: expect.any(String) })],
    });
    await expect(
      api.audit.list({ runId: 'run_1', role: 'reviewer' }),
    ).resolves.toMatchObject({
      events: [expect.objectContaining({ role: 'reviewer' })],
    });
    await expect(
      api.audit.list({ runId: 'run_1', role: 'qa' }),
    ).resolves.toMatchObject({
      events: [],
    });
    await expect(api.role.list()).resolves.toMatchObject({
      roles: [expect.objectContaining({ id: 'rd' })],
    });
    await expect(api.workflow.list()).resolves.toMatchObject({
      workflows: [expect.objectContaining({ id: 'standard-feature' })],
    });

    await api.close();
  });
});
