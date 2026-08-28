import { describe, expect, it } from 'vitest';

import {
  LEGAL_WORKFLOW_TRANSITIONS,
  assertWorkflowInstanceTransition,
  assertWorkflowTransition,
  canTransitionWorkflowInstance,
  canWorkflowTransition,
  transitionWorkflowNode,
  writeWorkflowTerminal,
} from '../../src/workflow/state-machine.js';
import { WorkflowTerminalError } from '../../src/workflow/errors.js';
import {
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
  type TekonRepositories,
  type WorkflowInstance,
  type WorkflowStatus,
} from '../../src/index.js';

describe('workflow state machine', () => {
  it('allows only explicit legal node transitions', () => {
    expect(canWorkflowTransition('pending', 'running')).toBe(true);
    expect(canWorkflowTransition('running', 'awaiting-gate')).toBe(true);
    expect(canWorkflowTransition('awaiting-gate', 'passed')).toBe(true);
    expect(canWorkflowTransition('awaiting-gate', 'needs-revision')).toBe(true);
    expect(canWorkflowTransition('needs-revision', 'running')).toBe(true);
    expect(canWorkflowTransition('running', 'blocked')).toBe(true);
    expect(canWorkflowTransition('running', 'paused')).toBe(true);
    expect(canWorkflowTransition('paused', 'running')).toBe(true);
    expect(canWorkflowTransition('running', 'interrupted')).toBe(true);
    expect(canWorkflowTransition('interrupted', 'running')).toBe(true);
    expect(canWorkflowTransition('pending', 'skipped')).toBe(true);
    expect(canWorkflowTransition('running', 'failed')).toBe(true);

    expect(canWorkflowTransition('pending', 'passed')).toBe(false);
    expect(canWorkflowTransition('passed', 'running')).toBe(false);
  });

  it('throws a readable error for illegal transitions', () => {
    expect(() => assertWorkflowTransition('passed', 'running')).toThrow(
      /illegal workflow transition: passed -> running/u,
    );
  });

  it('transitionWorkflowNode performs a valid transition and records history', () => {
    const snapshot = { status: 'pending' as const, revision: 0 };
    const result = transitionWorkflowNode(snapshot, 'running');

    expect(result.status).toBe('running');
    expect(result.revision).toBe(0); // non-needs-revision keeps revision unchanged
    expect(result.updatedAt).toEqual(expect.any(String));
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      from: 'pending',
      to: 'running',
      at: expect.any(String),
    });
  });

  it('transitionWorkflowNode bumps revision on needs-revision transition', () => {
    const snapshot = { status: 'running' as const, revision: 2 };
    const result = transitionWorkflowNode(snapshot, 'needs-revision');

    expect(result.status).toBe('needs-revision');
    expect(result.revision).toBe(3);
    expect(result.history).toHaveLength(1);
    expect(result.history[0]).toMatchObject({
      from: 'running',
      to: 'needs-revision',
    });
  });

  it('transitionWorkflowNode includes reason in history when provided', () => {
    const snapshot = { status: 'pending' as const };
    const result = transitionWorkflowNode(snapshot, 'running', {
      reason: 'manual trigger',
    });

    expect(result.history[0].reason).toBe('manual trigger');
    expect(result.history[0]).toMatchObject({
      from: 'pending',
      to: 'running',
      reason: 'manual trigger',
    });
  });

  it('transitionWorkflowNode appends to existing history', () => {
    const snapshot = {
      status: 'running' as const,
      history: [{ from: 'pending' as const, to: 'running' as const, at: '2026-01-01T00:00:00.000Z' }],
    };
    const result = transitionWorkflowNode(snapshot, 'awaiting-gate');

    expect(result.history).toHaveLength(2);
    expect(result.history[0].from).toBe('pending');
    expect(result.history[1]).toMatchObject({
      from: 'running',
      to: 'awaiting-gate',
    });
  });

  it('all terminal states have zero outgoing transitions', () => {
    // Note: 'passed' is no longer terminal — it can transition to
    // 'needs-revision' when an independent review finds changes-requested.
    const terminalStates = ['skipped', 'failed'] as const;
    // Verify 'passed' can only go to 'needs-revision'
    expect(canWorkflowTransition('passed', 'needs-revision')).toBe(true);
    const nonRevisionTargets = [
      'pending', 'running', 'awaiting-gate', 'blocked',
      'paused', 'interrupted', 'skipped', 'failed',
    ] as const;
    for (const target of nonRevisionTargets) {
      expect(canWorkflowTransition('passed', target)).toBe(false);
    }

    const allStates = [
      'pending',
      'running',
      'awaiting-gate',
      'passed',
      'needs-revision',
      'blocked',
      'paused',
      'interrupted',
      'skipped',
      'failed',
    ] as const;

    for (const terminal of terminalStates) {
      for (const target of allStates) {
        expect(canWorkflowTransition(terminal, target)).toBe(false);
      }
    }
  });

  it('passed node can transition to needs-revision for rework', () => {
    expect(canWorkflowTransition('passed', 'needs-revision')).toBe(true);

    const node = { status: 'passed' as const, revision: 0 };
    const result = transitionWorkflowNode(node, 'needs-revision');

    expect(result.status).toBe('needs-revision');
    expect(result.revision).toBe(1);
  });

  it('passed node cannot transition to other states', () => {
    expect(canWorkflowTransition('passed', 'running')).toBe(false);
    expect(canWorkflowTransition('passed', 'blocked')).toBe(false);
    expect(canWorkflowTransition('passed', 'failed')).toBe(false);
    expect(canWorkflowTransition('passed', 'pending')).toBe(false);
  });

  it('needs-revision to running transition works for re-execution', () => {
    expect(canWorkflowTransition('needs-revision', 'running')).toBe(true);
  });

  it('transitionWorkflowNode handles passed → needs-revision → running → passed revision chain', () => {
    let node = { status: 'passed' as const, revision: 0 };

    // Transition to needs-revision → revision should be 1
    node = transitionWorkflowNode(node, 'needs-revision');
    expect(node.status).toBe('needs-revision');
    expect(node.revision).toBe(1);

    // Transition to running → revision should stay 1
    node = transitionWorkflowNode(node, 'running');
    expect(node.status).toBe('running');
    expect(node.revision).toBe(1);

    // Transition to passed → revision should stay 1
    node = transitionWorkflowNode(node, 'passed');
    expect(node.status).toBe('passed');
    expect(node.revision).toBe(1);
  });

  it('throws for invalid source or target status values', () => {
    expect(() => canWorkflowTransition('completed' as any, 'running')).toThrow();
    expect(() => canWorkflowTransition('pending', 'success' as any)).toThrow();
    expect(() => canWorkflowTransition('idle' as any, 'done' as any)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Workflow instance (run-level) state machine
// ---------------------------------------------------------------------------
describe('workflow instance state machine', () => {
  it('allows only the explicit legal run-level transitions', () => {
    expect(canTransitionWorkflowInstance('pending', 'running')).toBe(true);
    expect(canTransitionWorkflowInstance('pending', 'cancelled')).toBe(true);
    expect(canTransitionWorkflowInstance('running', 'paused')).toBe(true);
    expect(canTransitionWorkflowInstance('running', 'blocked')).toBe(true);
    expect(canTransitionWorkflowInstance('running', 'passed')).toBe(true);
    expect(canTransitionWorkflowInstance('running', 'failed')).toBe(true);
    expect(canTransitionWorkflowInstance('running', 'interrupted')).toBe(true);
    expect(canTransitionWorkflowInstance('running', 'cancelled')).toBe(true);
    expect(canTransitionWorkflowInstance('paused', 'running')).toBe(true);
    expect(canTransitionWorkflowInstance('paused', 'blocked')).toBe(true);
    expect(canTransitionWorkflowInstance('paused', 'cancelled')).toBe(true);
    expect(canTransitionWorkflowInstance('blocked', 'running')).toBe(true);
    expect(canTransitionWorkflowInstance('blocked', 'failed')).toBe(true);
    expect(canTransitionWorkflowInstance('blocked', 'cancelled')).toBe(true);
    expect(canTransitionWorkflowInstance('interrupted', 'running')).toBe(true);
    expect(canTransitionWorkflowInstance('interrupted', 'failed')).toBe(true);
    expect(
      canTransitionWorkflowInstance('interrupted', 'cancelled'),
    ).toBe(true);

    expect(canTransitionWorkflowInstance('paused', 'passed')).toBe(false);
    expect(canTransitionWorkflowInstance('pending', 'passed')).toBe(false);
    expect(canTransitionWorkflowInstance('running', 'pending')).toBe(false);
  });

  it('treats passed/failed/cancelled as terminal with no outgoing transitions', () => {
    const all: WorkflowStatus[] = [
      'pending',
      'running',
      'paused',
      'blocked',
      'interrupted',
      'passed',
      'failed',
      'cancelled',
    ];
    for (const terminal of ['passed', 'failed', 'cancelled'] as const) {
      expect(LEGAL_WORKFLOW_TRANSITIONS[terminal]).toEqual([]);
      for (const target of all) {
        expect(
          canTransitionWorkflowInstance(terminal, target),
        ).toBe(false);
      }
    }
  });

  it('throws a readable error for illegal run-level transitions', () => {
    expect(() =>
      assertWorkflowInstanceTransition('passed', 'running'),
    ).toThrow(/illegal workflow instance transition: passed -> running/u);
  });
});

// ---------------------------------------------------------------------------
// writeWorkflowTerminal (M2 idempotent terminal writer + Gap A CAS)
// ---------------------------------------------------------------------------
describe('writeWorkflowTerminal', () => {
  async function seedRun(
    repositories: ReturnType<typeof createRepositories>,
    status: WorkflowStatus,
  ) {
    await repositories.createDemand({
      id: 'demand_1',
      title: 'Terminal writer',
      body: 'Exercise writeWorkflowTerminal.',
      createdAt: '2026-08-21T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_1',
      name: 'tekon',
      repoPath: '/tmp/tekon',
      createdAt: '2026-08-21T00:00:00.000Z',
    });
    await repositories.createWorkflowInstance({
      id: 'run_1',
      projectId: 'project_1',
      demandId: 'demand_1',
      status,
      currentNodeId: 'node_1',
      createdAt: '2026-08-21T00:00:00.000Z',
      updatedAt: '2026-08-21T00:00:00.000Z',
    });
  }

  function makeRepositories() {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    return { db, repositories };
  }

  it('returns written=false without touching the db when already in the target terminal state', async () => {
    const { db, repositories } = makeRepositories();
    await seedRun(repositories, 'cancelled');
    const before = await repositories.getWorkflowInstance('run_1');

    const result = await writeWorkflowTerminal(
      repositories,
      'run_1',
      'cancelled',
      'node_1',
    );

    expect(result.written).toBe(false);
    expect(result.workflow.status).toBe('cancelled');
    const after = await repositories.getWorkflowInstance('run_1');
    expect(after).toEqual(before);
    db.close();
  });

  it('writes a non-terminal run to the target terminal state', async () => {
    const { db, repositories } = makeRepositories();
    await seedRun(repositories, 'running');

    const result = await writeWorkflowTerminal(
      repositories,
      'run_1',
      'cancelled',
      'node_1',
    );

    expect(result.written).toBe(true);
    expect(result.workflow.status).toBe('cancelled');
    expect(result.workflow.currentNodeId).toBe('node_1');
    expect(
      await repositories.getWorkflowInstance('run_1'),
    ).toMatchObject({ status: 'cancelled' });
    db.close();
  });

  it('writes running to passed and clears the current node pointer', async () => {
    const { db, repositories } = makeRepositories();
    await seedRun(repositories, 'running');

    // passed with an explicit null clears current_node_id (the run is done and
    // no longer points at a node) — matches the legacy
    // updateWorkflowInstanceStatus(runId, 'passed', null) semantics.
    const result = await writeWorkflowTerminal(
      repositories,
      'run_1',
      'passed',
      null,
    );

    expect(result.written).toBe(true);
    expect(result.workflow.status).toBe('passed');
    expect(result.workflow.currentNodeId).toBeNull();
    db.close();
  });

  it('leaves the current node pointer unchanged when currentNodeId is omitted', async () => {
    const { db, repositories } = makeRepositories();
    await seedRun(repositories, 'running');

    // undefined (omitted) leaves current_node_id as-is.
    const result = await writeWorkflowTerminal(repositories, 'run_1', 'passed');

    expect(result.written).toBe(true);
    expect(result.workflow.status).toBe('passed');
    expect(result.workflow.currentNodeId).toBe('node_1');
    db.close();
  });

  it('throws WorkflowTerminalError when the run is in a different terminal state', async () => {
    const { db, repositories } = makeRepositories();
    await seedRun(repositories, 'passed');

    await expect(
      writeWorkflowTerminal(repositories, 'run_1', 'cancelled'),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_TERMINAL',
      runId: 'run_1',
      status: 'passed',
    });
    expect(
      await repositories.getWorkflowInstance('run_1'),
    ).toMatchObject({ status: 'passed' });

    await repositories.updateWorkflowInstanceStatus('run_1', 'failed');
    await expect(
      writeWorkflowTerminal(repositories, 'run_1', 'passed'),
    ).rejects.toBeInstanceOf(WorkflowTerminalError);
    expect(
      await repositories.getWorkflowInstance('run_1'),
    ).toMatchObject({ status: 'failed' });
    db.close();
  });

  it('throws a generic error for illegal targets without writing', async () => {
    const { db, repositories } = makeRepositories();
    await seedRun(repositories, 'running');

    await expect(
      writeWorkflowTerminal(
        repositories,
        'run_1',
        'pending' as 'passed',
      ),
    ).rejects.toThrow(/illegal workflow instance transition/u);
    expect(
      await repositories.getWorkflowInstance('run_1'),
    ).toMatchObject({ status: 'running' });
    db.close();
  });

  it('MUST-FIX1: paused -> passed returns written=false instead of throwing', async () => {
    const { db, repositories } = makeRepositories();
    await seedRun(repositories, 'paused');

    const result = await writeWorkflowTerminal(
      repositories,
      'run_1',
      'passed',
      'node_1',
    );

    expect(result.written).toBe(false);
    expect(result.workflow.status).toBe('paused');
    expect(
      await repositories.getWorkflowInstance('run_1'),
    ).toMatchObject({ status: 'paused' });
    db.close();
  });

  it('throws when the run does not exist', async () => {
    const { db, repositories } = makeRepositories();
    await expect(
      writeWorkflowTerminal(repositories, 'run_missing', 'cancelled'),
    ).rejects.toThrow(/not found/u);
    db.close();
  });

  it('Gap A: re-judges when the CAS loses a race against a concurrent cancel', async () => {
    // Simulate: helper re-reads 'running', but between re-read and CAS a
    // concurrent cancel lands 'cancelled'. CAS changes=0, so the helper must
    // re-read and converge on WorkflowTerminalError instead of overwriting.
    let status: WorkflowStatus = 'running';
    let casCalls = 0;
    const repositories = {
      async getWorkflowInstance(): Promise<WorkflowInstance | null> {
        return {
          id: 'run_1',
          projectId: 'project_1',
          demandId: 'demand_1',
          status,
          currentNodeId: 'node_1',
          createdAt: '2026-08-21T00:00:00.000Z',
          updatedAt: '2026-08-21T00:00:00.000Z',
        };
      },
      async casWorkflowInstanceStatus(
        _runId: string,
        expectedFrom: WorkflowStatus,
        to: WorkflowStatus,
      ) {
        casCalls += 1;
        expect(expectedFrom).toBe('running');
        expect(to).toBe('passed');
        // Concurrent writer wins the race.
        status = 'cancelled';
        return {
          changed: false,
          workflow: {
            id: 'run_1',
            projectId: 'project_1',
            demandId: 'demand_1',
            status: 'cancelled',
            currentNodeId: 'node_1',
            createdAt: '2026-08-21T00:00:00.000Z',
            updatedAt: '2026-08-21T00:00:01.000Z',
          },
        };
      },
    } as unknown as TekonRepositories;

    await expect(
      writeWorkflowTerminal(repositories, 'run_1', 'passed'),
    ).rejects.toMatchObject({
      code: 'WORKFLOW_TERMINAL',
      runId: 'run_1',
      status: 'cancelled',
    });
    expect(casCalls).toBeGreaterThanOrEqual(1);
    expect(status).toBe('cancelled');
  });

  it('Gap A: retries the CAS and succeeds when the race settles on the same target', async () => {
    // First CAS loses to a concurrent paused write; re-read sees 'paused',
    // second CAS wins paused -> cancelled.
    let status: WorkflowStatus = 'running';
    let casCalls = 0;
    const repositories = {
      async getWorkflowInstance(): Promise<WorkflowInstance | null> {
        return {
          id: 'run_1',
          projectId: 'project_1',
          demandId: 'demand_1',
          status,
          currentNodeId: 'node_1',
          createdAt: '2026-08-21T00:00:00.000Z',
          updatedAt: '2026-08-21T00:00:00.000Z',
        };
      },
      async casWorkflowInstanceStatus(
        _runId: string,
        expectedFrom: WorkflowStatus,
        to: WorkflowStatus,
        _nodeId?: string | null,
      ) {
        casCalls += 1;
        if (casCalls === 1) {
          status = 'paused';
          return {
            changed: false,
            workflow: null,
          };
        }
        expect(expectedFrom).toBe('paused');
        expect(to).toBe('cancelled');
        status = 'cancelled';
        return {
          changed: true,
          workflow: {
            id: 'run_1',
            projectId: 'project_1',
            demandId: 'demand_1',
            status: 'cancelled',
            currentNodeId: 'node_1',
            createdAt: '2026-08-21T00:00:00.000Z',
            updatedAt: '2026-08-21T00:00:02.000Z',
          },
        };
      },
    } as unknown as TekonRepositories;

    const result = await writeWorkflowTerminal(
      repositories,
      'run_1',
      'cancelled',
      'node_1',
    );
    expect(result.written).toBe(true);
    expect(result.workflow.status).toBe('cancelled');
    expect(casCalls).toBe(2);
  });
});
