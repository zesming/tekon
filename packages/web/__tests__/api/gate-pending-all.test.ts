import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

// PD-22: the global approval queue must surface pending decisions from every
// run in scope, not only the latest run. The fixture seeds one pending decision
// (decision_1) on run_1, while run_0 is terminal with no pending decision.
const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('gate.pendingAll', () => {
  it('returns every pending decision across scoped runs with its runId and recovery', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.gate.pendingAll();

    expect(result.pending).toHaveLength(1);
    const entry = result.pending[0]!;
    expect(entry.runId).toBe('run_1');
    expect(entry.decision.id).toBe('decision_1');
    expect(entry.decision.status).toBe('pending');
    expect(entry.recovery.runStatus).toBeTruthy();
  });

  it('drops a decision from the queue once it is decided', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const before = await api.gate.pendingAll();
    expect(before.pending.map((entry) => entry.decision.id)).toContain('decision_1');

    // Rejecting records the decision and removes it from the pending set; a
    // terminal-run guard does not apply here because run_1 is paused.
    await api.gate.reject({
      runId: 'run_1',
      decisionId: 'decision_1',
      actor: 'web-user',
      note: undefined,
      token: fixture.sessionToken,
    });

    const after = await api.gate.pendingAll();
    expect(after.pending.map((entry) => entry.decision.id)).not.toContain('decision_1');
  });
});
