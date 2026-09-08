import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  createHumanGate,
  createRepositories,
  isWorkflowTerminalError,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

describe('human gate', () => {
  it.each(['request', 'approve', 'reject'] as const)('R26: %s preserves cancellation that wins after the precheck', async (action) => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    try {
      await createRunFixture(repositories);
      if (action !== 'request') await repositories.createHumanDecision({
        id: 'decision_race', runId: 'run_1', nodeId: 'node_1', status: 'pending', createdAt: new Date().toISOString(),
      });
      db.exec(`create trigger cancel_during_decision after ${action === 'request' ? 'insert' : 'update'} on human_decisions
        begin update workflow_instances set status='cancelled' where id=new.run_id; end`);
      const gate = createHumanGate({ repositories });
      const operation = action === 'request' ? gate.requestHumanGate({ runId: 'run_1', nodeId: 'node_1' })
        : action === 'approve' ? gate.approveHumanGate('decision_race', 'reviewer') : gate.rejectHumanGate('decision_race', 'reviewer');
      await expect(operation).rejects.toMatchObject({ name: 'WorkflowTerminalError' });
      expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({ status: 'cancelled' });
    } finally { db.close(); }
  });
  it('pauses a workflow for human approval and resumes the blocked node', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories);
    await repositories.recordGateResult({
      id: 'gate_1',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'human',
      gateKey: '00:human',
      status: 'blocked',
      durationMs: 0,
      retries: 0,
      failureClassification: 'human-approval',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    const humanGate = createHumanGate({ repositories });

    const decision = await humanGate.requestHumanGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gateResultId: 'gate_1',
      note: 'Needs review',
    });

    expect(decision).toMatchObject({ status: 'pending', nodeId: 'node_1' });
    expect(await repositories.getNode('node_1')).toMatchObject({
      status: 'paused',
    });
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'paused',
    });

    await humanGate.approveHumanGate(decision.id, 'zhaoensheng', 'approved');

    expect(await repositories.getHumanDecision(decision.id)).toMatchObject({
      status: 'approved',
      actor: 'zhaoensheng',
    });
    expect(await repositories.getNode('node_1')).toMatchObject({
      status: 'running',
    });
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'running',
    });
    expect(await repositories.listGateResults('run_1')).toContainEqual(
      expect.objectContaining({
        id: 'gate_1',
        gateKey: '00:human',
        status: 'passed',
        failureClassification: null,
      }),
    );
    db.close();
  });

  it('rejects a pending human decision and blocks the workflow', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories);
    await repositories.recordGateResult({
      id: 'gate_1',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'human',
      status: 'blocked',
      durationMs: 0,
      retries: 0,
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    const humanGate = createHumanGate({ repositories });

    const decision = await humanGate.requestHumanGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gateResultId: 'gate_1',
      note: 'Needs review',
    });
    await humanGate.rejectHumanGate(decision.id, 'reviewer', 'rejected');

    expect(await repositories.getHumanDecision(decision.id)).toMatchObject({
      status: 'rejected',
      actor: 'reviewer',
    });
    expect(await repositories.getNode('node_1')).toMatchObject({
      status: 'blocked',
    });
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'blocked',
    });
    expect(await repositories.listGateResults('run_1')).toContainEqual(
      expect.objectContaining({
        id: 'gate_1',
        status: 'failed',
        failureClassification: 'human-rejected',
      }),
    );
    db.close();
  });

  it.each([
    ['cancelled', 'cancelled'],
    ['passed', 'passed'],
    ['failed', 'failed'],
  ] as const)(
    'M8: approveHumanGate throws WorkflowTerminalError on a %s run without writing',
    async (terminalStatus) => {
      const db = openTekonDatabase({ filename: ':memory:' });
      migrateDatabase(db);
      const repositories = createRepositories(db);
      await createRunFixture(repositories);
      await repositories.updateWorkflowInstanceStatus('run_1', terminalStatus);
      const decision = await repositories.createHumanDecision({
        id: 'decision_terminal',
        runId: 'run_1',
        nodeId: 'node_1',
        gateResultId: null,
        status: 'pending',
        note: null,
        createdAt: '2026-08-21T00:00:00.000Z',
      });
      const humanGate = createHumanGate({ repositories });

      await expect(
        humanGate.approveHumanGate(decision.id, 'cli', 'should fail'),
      ).rejects.toSatisfy((error) => {
        expect(isWorkflowTerminalError(error)).toBe(true);
        expect(error).toMatchObject({
          code: 'WORKFLOW_TERMINAL',
          runId: 'run_1',
          status: terminalStatus,
        });
        return true;
      });

      // Nothing was written.
      expect(await repositories.getHumanDecision(decision.id)).toMatchObject({
        status: 'pending',
        actor: null,
      });
      expect(await repositories.getNode('node_1')).toMatchObject({
        status: 'running',
      });
      expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
        status: terminalStatus,
      });
      db.close();
    },
  );

  it('M8: rejectHumanGate throws WorkflowTerminalError on a cancelled run without writing', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories);
    await repositories.updateWorkflowInstanceStatus('run_1', 'cancelled');
    const decision = await repositories.createHumanDecision({
      id: 'decision_terminal_reject',
      runId: 'run_1',
      nodeId: 'node_1',
      gateResultId: null,
      status: 'pending',
      note: null,
      createdAt: '2026-08-21T00:00:00.000Z',
    });
    const humanGate = createHumanGate({ repositories });

    await expect(
      humanGate.rejectHumanGate(decision.id, 'cli', 'should fail'),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_TERMINAL',
      runId: 'run_1',
      status: 'cancelled',
    });

    expect(await repositories.getHumanDecision(decision.id)).toMatchObject({
      status: 'pending',
      actor: null,
    });
    expect(await repositories.getNode('node_1')).toMatchObject({
      status: 'running',
    });
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'cancelled',
    });
    db.close();
  });

  it('M8: approve on a paused (non-terminal) run still works', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories);
    await repositories.updateWorkflowInstanceStatus('run_1', 'paused', 'node_1');
    const decision = await repositories.createHumanDecision({
      id: 'decision_paused',
      runId: 'run_1',
      nodeId: 'node_1',
      gateResultId: null,
      status: 'pending',
      note: null,
      createdAt: '2026-08-21T00:00:00.000Z',
    });
    const humanGate = createHumanGate({ repositories });

    const approved = await humanGate.approveHumanGate(
      decision.id,
      'cli',
      'ok',
    );
    expect(approved.status).toBe('approved');
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'running',
    });
    db.close();
  });

  it('does not rewrite a rejected decision when a later approval uses the pending CAS', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories);
    await repositories.recordGateResult({
      id: 'gate_reject_then_approve',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'human',
      status: 'blocked',
      durationMs: 0,
      retries: 0,
      failureClassification: 'human-approval',
      createdAt: '2026-08-21T00:00:00.000Z',
    });
    const humanGate = createHumanGate({ repositories });
    const decision = await humanGate.requestHumanGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gateResultId: 'gate_reject_then_approve',
    });

    await humanGate.rejectHumanGate(decision.id, 'reviewer-a', 'reject first');

    await expect(
      humanGate.approveHumanGate(decision.id, 'reviewer-b', 'approve later'),
    ).rejects.toThrow(
      `human decision was already decided: ${decision.id} (expected pending)`,
    );

    expect(await repositories.getHumanDecision(decision.id)).toMatchObject({
      status: 'rejected',
      actor: 'reviewer-a',
      note: 'reject first',
    });
    expect(await repositories.getNode('node_1')).toMatchObject({
      status: 'blocked',
    });
    expect(await repositories.getWorkflowInstance('run_1')).toMatchObject({
      status: 'blocked',
    });
    expect(await repositories.listGateResults('run_1')).toContainEqual(
      expect.objectContaining({
        id: 'gate_reject_then_approve',
        status: 'failed',
        failureClassification: 'human-rejected',
      }),
    );
    db.close();
  });

  it('allows only one decision from two real database connections', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'tekon-human-gate-cas-'));
    const filename = join(directory, 'tekon.sqlite');
    const db1 = openTekonDatabase({ filename });
    const db2 = openTekonDatabase({ filename });
    try {
      migrateDatabase(db1);
      const repositories1 = createRepositories(db1);
      const repositories2 = createRepositories(db2);
      await createRunFixture(repositories1);
      await repositories1.recordGateResult({
        id: 'gate_concurrent_decision',
        runId: 'run_1',
        nodeId: 'node_1',
        gateType: 'human',
        status: 'blocked',
        durationMs: 0,
        retries: 0,
        failureClassification: 'human-approval',
        createdAt: '2026-08-21T00:00:00.000Z',
      });
      const decision = await createHumanGate({
        repositories: repositories1,
      }).requestHumanGate({
        runId: 'run_1',
        nodeId: 'node_1',
        gateResultId: 'gate_concurrent_decision',
      });

      const [approved, rejected] = await Promise.allSettled([
        createHumanGate({ repositories: repositories1 }).approveHumanGate(
          decision.id,
          'connection-1',
          'approve concurrently',
        ),
        createHumanGate({ repositories: repositories2 }).rejectHumanGate(
          decision.id,
          'connection-2',
          'reject concurrently',
        ),
      ]);
      const settled = [approved, rejected];
      expect(
        settled.filter((result) => result.status === 'fulfilled'),
      ).toHaveLength(1);
      const loser = settled.find((result) => result.status === 'rejected');
      expect(loser).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({
          message: `human decision was already decided: ${decision.id} (expected pending)`,
        }),
      });

      const persisted = await repositories1.getHumanDecision(decision.id);
      expect(persisted?.status).toMatch(/^(approved|rejected)$/u);
      if (persisted?.status === 'approved') {
        expect(await repositories1.getNode('node_1')).toMatchObject({
          status: 'running',
        });
        expect(await repositories1.getWorkflowInstance('run_1')).toMatchObject({
          status: 'running',
        });
        expect(await repositories1.listGateResults('run_1')).toContainEqual(
          expect.objectContaining({
            id: 'gate_concurrent_decision',
            status: 'passed',
            failureClassification: null,
          }),
        );
      } else {
        expect(await repositories1.getNode('node_1')).toMatchObject({
          status: 'blocked',
        });
        expect(await repositories1.getWorkflowInstance('run_1')).toMatchObject({
          status: 'blocked',
        });
        expect(await repositories1.listGateResults('run_1')).toContainEqual(
          expect.objectContaining({
            id: 'gate_concurrent_decision',
            status: 'failed',
            failureClassification: 'human-rejected',
          }),
        );
      }
    } finally {
      db1.close();
      db2.close();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('updateHumanDecision CAS: expectedStatus mismatch returns null and does not write', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories);
    await repositories.createHumanDecision({
      id: 'decision_cas',
      runId: 'run_1',
      nodeId: 'node_1',
      gateResultId: null,
      status: 'pending',
      note: null,
      createdAt: '2026-08-21T00:00:00.000Z',
    });

    // First CAS flip (pending → approved) wins.
    const first = await repositories.updateHumanDecision(
      'decision_cas',
      { status: 'approved', actor: 'a', note: null, decidedAt: '2026-08-21T00:00:01.000Z' },
      'pending',
    );
    expect(first).toMatchObject({ status: 'approved', actor: 'a' });

    // Second CAS flip still expecting 'pending' loses: null, no overwrite.
    const second = await repositories.updateHumanDecision(
      'decision_cas',
      { status: 'rejected', actor: 'b', note: null, decidedAt: '2026-08-21T00:00:02.000Z' },
      'pending',
    );
    expect(second).toBeNull();
    expect(await repositories.getHumanDecision('decision_cas')).toMatchObject({
      status: 'approved',
      actor: 'a',
    });

    // Without expectedStatus the update is unconditional (legacy CLI path).
    const forced = await repositories.updateHumanDecision('decision_cas', {
      status: 'rejected',
      actor: 'c',
      note: null,
      decidedAt: '2026-08-21T00:00:03.000Z',
    });
    expect(forced).toMatchObject({ status: 'rejected', actor: 'c' });
    db.close();
  });
});

async function createRunFixture(
  repositories: ReturnType<typeof createRepositories>,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Human gate',
    body: 'Pause for approval.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath: '/tmp/tekon',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'running',
    currentNodeId: 'node_1',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    role: 'reviewer',
    status: 'running',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
}
