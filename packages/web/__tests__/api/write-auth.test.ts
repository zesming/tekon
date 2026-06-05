import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('web write authorization', () => {
  it('rejects write procedures with a wrong token and approves with the session token', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'wrong token',
        token: 'wrong-token',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const result = await api.gate.approve({
      runId: 'run_1',
      decisionId: 'decision_1',
      actor: 'human-reviewer',
      note: 'approved from test',
      token: fixture.sessionToken,
    });

    expect(result.decision).toMatchObject({
      id: 'decision_1',
      status: 'approved',
      actor: 'human-reviewer',
    });

    const gates = await api.gate.list({ runId: 'run_1' });
    expect(gates.gates).toContainEqual(
      expect.objectContaining({ id: 'gate_1', status: 'passed' }),
    );

    const detail = await api.project.detail({ projectId: 'project_1' });
    expect(detail.runs[0]).toMatchObject({
      id: 'run_1',
      status: 'running',
      currentNodeId: 'node_1',
    });

    await api.close();
  });

  it('rejects run writes outside the explicit project root even with a valid token', async () => {
    const fixture = await createWebFixtureProject({
      includeOutOfScopeProject: true,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.project.pause({
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.project.resume({
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.project.cancel({
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.project.clean({
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await api.close();
  });
});
