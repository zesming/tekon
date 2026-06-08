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
      status: 'passed',
      currentNodeId: null,
    });
    const audit = await api.audit.list({ runId: 'run_1' });
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'human.gate.approved' }),
        expect.objectContaining({ type: 'run.resumed' }),
      ]),
    );

    await expect(
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'duplicate',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });

  it('rejecting a human gate blocks the workflow instead of resuming it', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.gate.reject({
      runId: 'run_1',
      decisionId: 'decision_1',
      actor: 'human-reviewer',
      note: 'needs changes',
      token: fixture.sessionToken,
    });

    expect(result.decision).toMatchObject({
      id: 'decision_1',
      status: 'rejected',
      actor: 'human-reviewer',
    });
    const detail = await api.project.detail({ projectId: 'project_1' });
    expect(detail.runs[0]).toMatchObject({
      id: 'run_1',
      status: 'blocked',
      currentNodeId: 'node_1',
    });
    const audit = await api.audit.list({ runId: 'run_1' });
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'human.gate.rejected' }),
      ]),
    );
    expect(audit.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.resumed' }),
      ]),
    );

    await api.close();
  });

  it('does not approve a human gate when the run provider snapshot is missing', async () => {
    const fixture = await createWebFixtureProject({
      includeProviderSnapshot: false,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'cannot resume safely',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const gates = await api.gate.list({ runId: 'run_1' });
    expect(gates.pendingDecisions).toContainEqual(
      expect.objectContaining({ id: 'decision_1', status: 'pending' }),
    );

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
