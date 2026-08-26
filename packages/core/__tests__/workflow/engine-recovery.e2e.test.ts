import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  JOB_ABORT_REASON_OWNERSHIP_LOST,
  migrateDatabase,
  openTekonDatabase,
  type GateEngine,
} from '../../src/index.js';
import type { WorktreeManager } from '../../src/runtime/worktree-manager.js';
import type { WorktreeLease } from '../../src/types/config.js';

describe('workflow engine recovery e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('resumes an interrupted run from the interrupted node while preserving previous artifacts and audit chain', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-recovery-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const mock = createMockAgentAdapter();
    let interrupted = false;

    const firstEngine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: {
        async runAgent(input) {
          if (
            input.runContext.nodeId.endsWith('_rd-implementation') &&
            !interrupted
          ) {
            interrupted = true;
            throw new Error('simulated interruption');
          }
          return mock.runAgent(input);
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    const interruptedRun = await firstEngine.startRun({
      demandText: '恢复中断的运行',
      templateName: 'standard-feature',
      mode: 'template',
    });

    expect(interruptedRun.workflow.status).toBe('interrupted');
    expect(await repositories.listArtifacts(interruptedRun.runId)).not.toEqual(
      [],
    );

    const secondEngine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: {
        async runAgent(input) {
          if (input.runContext.nodeId.endsWith('_rd-implementation')) {
            expect(input.requiredArtifactTypes).toEqual(
              expect.arrayContaining(['tech-design', 'code-changes']),
            );
            expect(input.prompt).toContain('Tekon artifact protocol');
          }
          return mock.runAgent(input);
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    const resumed = await secondEngine.resumeRun(interruptedRun.runId);

    expect(resumed.workflow.status).toBe('passed');
    expect(
      await repositories.listArtifacts(
        resumed.runId,
        undefined,
        'delivery-package',
      ),
    ).not.toEqual([]);
    expect(await audit.verify(resumed.runId)).toEqual({ valid: true });

    db.close();
  });

  it('a fenced (ownership-lost) executor does not revert a terminal run recovered by the new owner', async () => {
    // Regression (second-review F-01 residual): the ownership-lost abort path
    // must NOT write node/workflow state. If it does, a zombie worker whose
    // job was recovered by a new owner (which already settled `passed`) reverts
    // the run to `interrupted`, breaking terminal-state monotonicity.
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-fenced-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const mock = createMockAgentAdapter();

    // A fencing signal (the new owner recovered this job; this executor is a
    // stale zombie). It is NOT a user cancellation.
    const fence = new AbortController();

    let sawImplementation = false;
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      signal: fence.signal,
      adapter: {
        async runAgent(input) {
          if (input.runContext.nodeId.endsWith('_rd-implementation')) {
            sawImplementation = true;
            // Simulate the recovering owner: it has already driven this run to
            // a terminal `passed` in the shared DB. Then this stale executor is
            // fenced and its agent run throws — exercising the ownership-lost
            // interrupt path in node-executor.
            await repositories.updateWorkflowInstanceStatus(
              input.runContext.runId,
              'passed',
              null,
            );
            fence.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
            throw new Error('fenced: ownership lost mid-node');
          }
          return mock.runAgent(input);
        },
      },
      gateEngine: createPassingGateEngine(repositories),
    });

    const run = await engine.startRun({
      demandText: '被 fence 的僵尸执行器不得回退终态',
      templateName: 'standard-feature',
      mode: 'template',
    });

    expect(sawImplementation).toBe(true);
    // The new owner's terminal `passed` MUST survive — the fenced executor
    // stood down without touching the shared workflow row.
    const persisted = await repositories.getWorkflowInstance(run.runId);
    expect(persisted?.status).toBe('passed');

    db.close();
  });

  it('F4-P0-02: a fence at the PLAN boundary does not settle the run cancelled', async () => {
    // Regression (fourth-review F4-P0-02): executePlan's node-boundary and
    // final `if (options.signal?.aborted)` checks must classify the abort. An
    // ownership-lost fence is NOT a user cancel; writing `cancelled` at the
    // plan boundary would let a stale worker terminate a run the recovering
    // owner is still executing (and later flip it, discarding real work).
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-fenced-plan-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const mock = createMockAgentAdapter();

    const fence = new AbortController();
    let fencedAtCheckpoint = false;

    // The fence lands at a node-boundary checkpoint (after a node passed,
    // before the next node's top-of-loop check). The run row is still
    // `running` (NOT yet terminal), so a bare settleCancelled CAS
    // `where status='running'` WOULD succeed — this is exactly the window the
    // classifier must close.
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      signal: fence.signal,
      adapter: {
        async runAgent(input) {
          return mock.runAgent(input);
        },
      },
      gateEngine: createPassingGateEngine(repositories),
      onNodeCheckpoint: async () => {
        if (!fencedAtCheckpoint) {
          fencedAtCheckpoint = true;
          // Recovering owner reclaimed the job; fence this stale executor.
          // The run is still `running` — the fenced worker must stand down at
          // the next boundary, not write `cancelled`.
          fence.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
        }
      },
    });

    const run = await engine.startRun({
      demandText: 'plan 边界被 fence 不得写 cancelled',
      templateName: 'standard-feature',
      mode: 'template',
    });

    expect(fencedAtCheckpoint).toBe(true);
    // The fenced executor stood down at the plan boundary. The run row must NOT
    // be `cancelled` — the recovering owner remains authoritative (the run
    // stays in a non-terminal state for the new owner to finish).
    const persisted = await repositories.getWorkflowInstance(run.runId);
    expect(persisted?.status).not.toBe('cancelled');

    db.close();
  });

  it('F4-P0-03: a fence on the node SUCCESS path stands down before finalize/promote', async () => {
    // Regression (fourth-review F4-P0-03 4.3.4): the node success path
    // (recordQaValidationRef → finalizeExecutionLease → checkedTransitionNode
    // 'passed') only guarded ownership-lost in its CATCH. When finalize
    // SUCCEEDS while fenced, a stale executor commits + promotes its worktree
    // onto the run branch the recovering owner already owns
    // (promoteLeaseToRunBranch = `git branch -f`, no expected-old-SHA CAS),
    // silently overwriting the new owner's delivery. The success path must
    // pre-check the fence and stand down BEFORE any commit/promote side effect.
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-fenced-succ-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const mock = createMockAgentAdapter();

    const fence = new AbortController();
    let fencedAfterGate = false;
    let gateCounter = 0;

    // Spy worktree manager: the guard's real purpose is to prevent commit /
    // promote (git side effects) while fenced. Assert these are NEVER called on
    // the implementation node after the fence lands.
    let commitCalls = 0;
    let promoteCalls = 0;
    const leases = new Map<string, WorktreeLease>();
    const worktreeManager: WorktreeManager = {
      async ensureRunBranch() {
        return 'tekon/run';
      },
      async createLease(input) {
        const lease: WorktreeLease = {
          id: `lease_${input.nodeId}`,
          runId: input.runId,
          nodeId: input.nodeId,
          role: input.role,
          repoPath,
          worktreePath: join(repoPath, '.tekon', 'wt', input.nodeId),
          branchName: `tekon/${input.nodeId}`,
          createdAt: new Date().toISOString(),
        };
        leases.set(lease.id, lease);
        return lease;
      },
      async inspectLeaseSourceChanges() {
        return { changedPaths: [], headChanged: false, currentHead: 'HEAD' };
      },
      async listLeaseSourceChanges() {
        return [];
      },
      async getLeaseHead() {
        return 'HEAD';
      },
      async commitLeaseChanges(leaseId) {
        if (leaseId.endsWith('_rd-implementation')) commitCalls += 1;
        return true;
      },
      async promoteLeaseToRunBranch(input) {
        if (input.leaseId.endsWith('_rd-implementation')) promoteCalls += 1;
        return 'tekon/run';
      },
      async releaseLease() {},
      async pruneStaleLeases() {},
      async listLeases(runId) {
        return [...leases.values()].filter((l) => l.runId === runId);
      },
    };

    // Gate passes normally; as it returns for the implementation node, simulate
    // the recovering owner having settled `passed` and fence this executor. The
    // agent already succeeded, so execution proceeds down the SUCCESS path
    // (finalize/commit/promote) — which must now stand down.
    const fencingGateEngine: GateEngine = {
      async runGate(input) {
        gateCounter += 1;
        const isImplNode = input.nodeId.endsWith('_rd-implementation');
        if (isImplNode && !fencedAfterGate) {
          fencedAfterGate = true;
          await repositories.updateWorkflowInstanceStatus(
            input.runId,
            'passed',
            null,
          );
          fence.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
        }
        return repositories.recordGateResult({
          id: `gate_${input.nodeId}_${input.gate.type}_${gateCounter}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          status: 'passed',
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
      async createAutoFixRepairNode(input) {
        return repositories.createNode({
          id: `repair_${input.failedGateResult.id}`,
          runId: input.failedGateResult.runId,
          role: input.fixerRole,
          status: 'pending',
          gates: [],
          dependencies: [input.failedGateResult.nodeId],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
    };

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      signal: fence.signal,
      worktreeManager,
      adapter: {
        async runAgent(input) {
          return mock.runAgent(input);
        },
      },
      gateEngine: fencingGateEngine,
    });

    const run = await engine.startRun({
      demandText: '成功路径被 fence 不得 finalize/promote',
      templateName: 'standard-feature',
      mode: 'template',
    });

    expect(fencedAfterGate).toBe(true);
    // The fenced success path stood down BEFORE finalize: no commit, no promote
    // of the stale worktree onto the run branch.
    expect(commitCalls).toBe(0);
    expect(promoteCalls).toBe(0);
    // The recovering owner's terminal `passed` MUST survive.
    const persisted = await repositories.getWorkflowInstance(run.runId);
    expect(persisted?.status).toBe('passed');

    db.close();
  });

  it('a fence during the GATES phase does not revert a terminal run (M1/M2/M3)', async () => {
    // Regression (fix-review M1-M3): the ownership-lost guard must also cover
    // the post-agent-success path (gates / finalize / gate-runner repair+
    // exhausted). Here the agent SUCCEEDS, then the fence lands while a gate
    // runs — the fenced executor's gate/finalize catch and the gate-runner's
    // repair/exhausted writes must NOT revert the recovering owner's `passed`.
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-fenced-gate-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const mock = createMockAgentAdapter();

    const fence = new AbortController();
    let fencedAtGate = false;
    let gateCounter = 0;

    // Gate engine: the agent already succeeded (node awaiting-gate). On the
    // first gate of the implementation node, simulate the recovering owner
    // having settled `passed`, fence this executor, and return a `failed` gate
    // result (as a SIGKILLed gate command maps) to drive the repair/exhausted
    // path.
    const fencingGateEngine: GateEngine = {
      async runGate(input) {
        gateCounter += 1;
        const isImplNode = input.nodeId.endsWith('_rd-implementation');
        if (isImplNode && !fencedAtGate) {
          fencedAtGate = true;
          await repositories.updateWorkflowInstanceStatus(
            input.runId,
            'passed',
            null,
          );
          fence.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
          return repositories.recordGateResult({
            id: `gate_${input.nodeId}_${input.gate.type}_${gateCounter}`,
            runId: input.runId,
            nodeId: input.nodeId,
            gateType: input.gate.type,
            status: 'failed',
            durationMs: 0,
            retries: 0,
            createdAt: new Date().toISOString(),
          });
        }
        return repositories.recordGateResult({
          id: `gate_${input.nodeId}_${input.gate.type}_${gateCounter}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          status: 'passed',
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
      async createAutoFixRepairNode(input) {
        return repositories.createNode({
          id: `repair_${input.failedGateResult.id}`,
          runId: input.failedGateResult.runId,
          role: input.fixerRole,
          status: 'pending',
          gates: [],
          dependencies: [input.failedGateResult.nodeId],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        });
      },
    };

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      signal: fence.signal,
      adapter: {
        async runAgent(input) {
          return mock.runAgent(input);
        },
      },
      gateEngine: fencingGateEngine,
    });

    const run = await engine.startRun({
      demandText: 'gates 阶段被 fence 不得回退终态',
      templateName: 'standard-feature',
      mode: 'template',
    });

    expect(fencedAtGate).toBe(true);
    // Terminal `passed` set by the recovering owner MUST survive the fenced
    // executor's gate/finalize/repair/exhausted bookkeeping.
    const persisted = await repositories.getWorkflowInstance(run.runId);
    expect(persisted?.status).toBe('passed');

    db.close();
  });
});

function createPassingGateEngine(
  repositories: ReturnType<typeof createRepositories>,
): GateEngine {
  let gateCounter = 0;
  return {
    async runGate(input) {
      gateCounter += 1;
      return repositories.recordGateResult({
        id: `gate_${input.nodeId}_${input.gate.type}_${gateCounter}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        status: 'passed',
        durationMs: 0,
        retries: 0,
        createdAt: new Date().toISOString(),
      });
    },
    async createAutoFixRepairNode(input) {
      return repositories.createNode({
        id: `repair_${input.failedGateResult.id}`,
        runId: input.failedGateResult.runId,
        role: input.fixerRole,
        status: 'pending',
        gates: [],
        dependencies: [input.failedGateResult.nodeId],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    },
  };
}
