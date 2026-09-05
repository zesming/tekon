import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAuditLogger,
  createAutomationJobExecutor,
  createJobRepository,
  createJobRunner,
  createMockAgentAdapter,
  createRepositories,
  createSessionEventBus,
  createSessionEventStore,
  createSubprocessRegistry,
  createWorkflowEngine,
  createWorkflowJobExecutor,
  createWriteQueue,
  isJobCancellationAbort,
  isJobOwnershipLostAbort,
  isJobShutdownAbort,
  JOB_ABORT_REASON_OWNERSHIP_LOST,
  JOB_ABORT_REASON_SHUTDOWN,
  migrateDatabase,
  openTekonDatabase,
  scopedId,
  type AgentRunInput,
  type CreateWorkflowEngineOptions,
  type DurableJobRunner,
  type JobExecutionContext,
  type JobExecutor,
  type JobStatus,
  type Session,
  type SessionEventStore,
  type TekonRepositories,
  type WorkflowTemplate,
} from '../../src/index.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error('condition not met before timeout');
    }
    await sleep(5);
  }
}

const tempDirs: string[] = [];
const runners: DurableJobRunner[] = [];

afterEach(async () => {
  for (const runner of runners.splice(0)) {
    try {
      await runner.stop();
    } catch {
      // best-effort cleanup
    }
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const minimalTemplate: WorkflowTemplate = {
  id: 'minimal-stop-test',
  name: 'Minimal Stop Test',
  version: 1,
  retryPolicy: {
    maxAttempts: 1,
    backoffMs: 0,
    strategy: 'fixed',
    onExhausted: 'block',
  },
  phases: [
    {
      id: 'phase_1',
      name: 'Phase 1',
      dependsOn: [],
      parallel: false,
      nodes: [
        {
          id: 'node_a',
          role: 'pm',
          inputs: [],
          outputs: [{ id: 'out_a', type: 'demand-card' }],
          gates: [],
          dependsOn: [],
        },
        {
          id: 'node_b',
          role: 'rd',
          inputs: [{ id: 'in_a', fromNodeId: 'node_a', type: 'demand-card' }],
          outputs: [{ id: 'out_b', type: 'code-changes' }],
          gates: [],
          dependsOn: ['node_a'],
        },
      ],
    },
  ],
};

function setupEngineHarness(
  overrides: Partial<CreateWorkflowEngineOptions> = {},
) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-stop-test-'));
  tempDirs.push(repoPath);
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  const mock = createMockAgentAdapter();
  const runAgentSpy = vi.fn((input: AgentRunInput) => mock.runAgent(input));
  const engine = createWorkflowEngine({
    repoPath,
    dataDir: '.tekon',
    repositories,
    audit,
    adapter: { runAgent: (input) => runAgentSpy(input) },
    ...overrides,
  });
  return { engine, repositories, audit, runAgentSpy, mock, db, repoPath };
}

async function seedRunAndSession(
  repositories: TekonRepositories,
  sessions: SessionEventStore,
  runId = 'run_1',
): Promise<Session> {
  const now = new Date().toISOString();
  await repositories.createDemand({
    id: 'demand_' + runId,
    title: 'test demand',
    body: 'test body',
    source: 'template',
    createdAt: now,
  });
  await repositories.createProject({
    id: 'project_' + runId,
    name: 'tekon-test',
    repoPath: '/tmp/tekon-test',
    createdAt: now,
  });
  await repositories.createWorkflowInstance({
    id: runId,
    projectId: 'project_' + runId,
    demandId: 'demand_' + runId,
    status: 'running',
    kind: 'workflow',
    createdAt: now,
    updatedAt: now,
  });
  const workspace = await sessions.getOrCreateDefaultWorkspace('/tmp/tekon-test');
  return sessions.createSession({
    workspaceId: workspace.id,
    title: 'test',
    profile: 'human-web',
    runId,
  });
}

describe('job runner stop race and shutdown semantics (Item 8)', () => {
  it('waits for an already-entered claim poll before snapshotting pending work', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();
    let executionCount = 0;
    const executor: JobExecutor = {
      async execute() {
        executionCount += 1;
        return { status: 'done' };
      }
    };
    const runner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor,
      pollIntervalMs: 1,
      workerId: 'worker_stop_barrier',
    });
    runners.push(runner);

    const workspace =
      await sessions.getOrCreateDefaultWorkspace('/tmp/stop-barrier');
    const session = await sessions.createSession({
      workspaceId: workspace.id,
      title: 'stop barrier',
      profile: 'human-web',
      runId: 'run_stop_barrier',
    });
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    let releaseClaim!: () => void;
    const claimGate = new Promise<void>((resolve) => {
      releaseClaim = resolve;
    });
    let markClaimEntered!: () => void;
    const claimEntered = new Promise<void>((resolve) => {
      markClaimEntered = resolve;
    });
    const originalClaimNext = jobs.claimNext.bind(jobs);
    vi.spyOn(jobs, 'claimNext').mockImplementation(async (...args) => {
      markClaimEntered();
      await claimGate;
      return originalClaimNext(...args);
    });

    runner.start();
    await claimEntered;

    let stopResolved = false;
    const stopPromise = runner.stop().then(() => {
      stopResolved = true;
    });
    await sleep(20);

    expect(stopResolved).toBe(false);

    releaseClaim();
    await stopPromise;
    await waitFor(async () => (await jobs.get(job.id))?.status === 'done');

    expect(executionCount).toBe(1);
    expect(await jobs.get(job.id)).toMatchObject({ status: 'done' });

    await sleep(20);
    expect(executionCount).toBe(1);
    db.close();
  });

  it('P0-ARCH-02: stop() returns within hard deadline when an uncooperative executor never settles', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();

    // Uncooperative executor that never resolves even on abort
    let started = false;
    const uncooperativeExecutor: JobExecutor = {
      execute() {
        started = true;
        return new Promise(() => {
          // never resolves or rejects
        });
      }
    };

    const runner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor: uncooperativeExecutor,
      pollIntervalMs: 2,
      stopSettleTimeoutMs: 10,
      stopHardTimeoutMs: 50,
      workerId: 'worker_uncooperative',
    });
    runners.push(runner);

    const workspace = await sessions.getOrCreateDefaultWorkspace('/tmp/stop-hard');
    const session = await sessions.createSession({
      workspaceId: workspace.id,
      title: 'uncooperative',
      profile: 'human-web',
      runId: 'run_uncooperative',
    });
    await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => started);

    const start = Date.now();
    await runner.stop();
    const elapsed = Date.now() - start;

    // Must resolve within bounded time (~60-200ms), NOT hang indefinitely.
    expect(elapsed).toBeLessThan(1000);
    db.close();
  });

  it('three abort classifications are mutually exclusive and do not cross-talk', () => {
    // 1. User cancellation (default / string reason / abort without reason)
    const userCancelCtrl1 = new AbortController();
    userCancelCtrl1.abort();
    expect(isJobCancellationAbort(userCancelCtrl1.signal)).toBe(true);
    expect(isJobShutdownAbort(userCancelCtrl1.signal)).toBe(false);
    expect(isJobOwnershipLostAbort(userCancelCtrl1.signal)).toBe(false);

    const userCancelCtrl2 = new AbortController();
    userCancelCtrl2.abort('user requested stop');
    expect(isJobCancellationAbort(userCancelCtrl2.signal)).toBe(true);
    expect(isJobShutdownAbort(userCancelCtrl2.signal)).toBe(false);
    expect(isJobOwnershipLostAbort(userCancelCtrl2.signal)).toBe(false);

    // 2. Shutdown abort
    const shutdownCtrl = new AbortController();
    shutdownCtrl.abort(JOB_ABORT_REASON_SHUTDOWN);
    expect(isJobShutdownAbort(shutdownCtrl.signal)).toBe(true);
    expect(isJobCancellationAbort(shutdownCtrl.signal)).toBe(false);
    expect(isJobOwnershipLostAbort(shutdownCtrl.signal)).toBe(false);

    // 3. Ownership-lost abort
    const ownershipLostCtrl = new AbortController();
    ownershipLostCtrl.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
    expect(isJobOwnershipLostAbort(ownershipLostCtrl.signal)).toBe(true);
    expect(isJobCancellationAbort(ownershipLostCtrl.signal)).toBe(false);
    expect(isJobShutdownAbort(ownershipLostCtrl.signal)).toBe(false);

    // 4. Unaborted / undefined signal
    const unabortedCtrl = new AbortController();
    expect(isJobCancellationAbort(unabortedCtrl.signal)).toBe(false);
    expect(isJobShutdownAbort(unabortedCtrl.signal)).toBe(false);
    expect(isJobOwnershipLostAbort(unabortedCtrl.signal)).toBe(false);

    expect(isJobCancellationAbort(undefined)).toBe(false);
    expect(isJobShutdownAbort(undefined)).toBe(false);
    expect(isJobOwnershipLostAbort(undefined)).toBe(false);
  });

  it('shutdown escalation settles job as interrupted, whereas user cancel settles as cancelled', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();

    class CooperativeExecutor implements JobExecutor {
      readonly started: JobExecutionContext[] = [];
      execute(ctx: JobExecutionContext): Promise<{ status: JobStatus; summary?: string }> {
        this.started.push(ctx);
        return new Promise((resolve) => {
          if (ctx.signal.aborted) {
            resolve({
              status: isJobShutdownAbort(ctx.signal)
                ? 'interrupted'
                : isJobCancellationAbort(ctx.signal)
                  ? 'cancelled'
                  : 'failed',
            });
            return;
          }
          ctx.signal.addEventListener(
            'abort',
            () => {
              resolve({
                status: isJobShutdownAbort(ctx.signal)
                  ? 'interrupted'
                  : isJobCancellationAbort(ctx.signal)
                    ? 'cancelled'
                    : 'failed',
              });
            },
            { once: true },
          );
        });
      }
    }

    const executor = new CooperativeExecutor();
    const runner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor,
      pollIntervalMs: 2,
      stopSettleTimeoutMs: 10,
      workerId: 'worker_coop',
    });
    runners.push(runner);

    const workspace = await sessions.getOrCreateDefaultWorkspace('/tmp/stop-coop');
    const session = await sessions.createSession({
      workspaceId: workspace.id,
      title: 'coop',
      profile: 'human-web',
      runId: 'run_coop',
    });
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);

    // Stop runner: Phase 2 aborts with JOB_ABORT_REASON_SHUTDOWN
    await runner.stop();

    const settledJob = await jobs.get(job.id);
    expect(settledJob).toMatchObject({
      status: 'interrupted',
      abortState: 'stopped',
    });

    db.close();
  });

  it('engine abort three-way split: shutdown -> interrupted, user cancel -> cancelled, ownership-lost -> stands down', async () => {
    // 1. Shutdown abort at start of run
    {
      const shutdownCtrl = new AbortController();
      shutdownCtrl.abort(JOB_ABORT_REASON_SHUTDOWN);
      const { engine, repositories, db } = setupEngineHarness({
        signal: shutdownCtrl.signal,
      });

      const result = await engine.startRun({
        demandText: 'Shutdown test',
        mode: 'template',
        workflowSpec: minimalTemplate,
      });

      expect(result.workflow.status).toBe('interrupted');
      const persisted = await repositories.getWorkflowInstance(result.runId);
      expect(persisted?.status).toBe('interrupted');
      db.close();
    }

    // 2. User cancel abort at start of run
    {
      const cancelCtrl = new AbortController();
      cancelCtrl.abort();
      const { engine, repositories, db } = setupEngineHarness({
        signal: cancelCtrl.signal,
      });

      const result = await engine.startRun({
        demandText: 'Cancel test',
        mode: 'template',
        workflowSpec: minimalTemplate,
      });

      expect(result.workflow.status).toBe('cancelled');
      const persisted = await repositories.getWorkflowInstance(result.runId);
      expect(persisted?.status).toBe('cancelled');
      db.close();
    }

    // 3. Ownership-lost abort stands down without mutating workflow
    {
      const ownershipCtrl = new AbortController();
      ownershipCtrl.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
      const { engine, repositories, db } = setupEngineHarness({
        signal: ownershipCtrl.signal,
      });

      const result = await engine.startRun({
        demandText: 'Ownership test',
        mode: 'template',
        workflowSpec: minimalTemplate,
      });

      // Returns the current workflow (still running), stands down without writing cancelled/interrupted
      expect(result.workflow.status).toBe('running');
      const persisted = await repositories.getWorkflowInstance(result.runId);
      expect(persisted?.status).toBe('running');
      db.close();
    }
  });

  it('engine abort at node boundary on shutdown updates workflow to interrupted', async () => {
    const shutdownCtrl = new AbortController();
    const { engine, repositories, db } = setupEngineHarness({
      signal: shutdownCtrl.signal,
      adapter: {
        runAgent: async () => {
          // Node A completes, but before Node B starts we abort with shutdown reason
          shutdownCtrl.abort(JOB_ABORT_REASON_SHUTDOWN);
          return {
            provider: 'mock',
            exitCode: 0,
            durationMs: 10,
            outputFiles: [],
            timedOut: false,
          };
        },
      },
    });

    const result = await engine.startRun({
      demandText: 'Node boundary shutdown test',
      mode: 'template',
      workflowSpec: minimalTemplate,
    });

    expect(result.workflow.status).toBe('interrupted');
    const persisted = await repositories.getWorkflowInstance(result.runId);
    expect(persisted?.status).toBe('interrupted');
    db.close();
  });

  it('node-executor updates workflow to interrupted (not cancelled) when shutdown abort arrives during agent run', async () => {
    const shutdownCtrl = new AbortController();
    const mock = createMockAgentAdapter();
    const { engine, repositories, db } = setupEngineHarness({
      signal: shutdownCtrl.signal,
      adapter: {
        runAgent: async (input) => {
          if (!shutdownCtrl.signal.aborted) {
            // Shutdown arrives while the agent is running
            shutdownCtrl.abort(JOB_ABORT_REASON_SHUTDOWN);
          }
          return mock.runAgent(input);
        },
      },
    });

    const result = await engine.startRun({
      demandText: 'Agent execution shutdown test',
      mode: 'template',
      workflowSpec: minimalTemplate,
    });

    expect(result.workflow.status).toBe('interrupted');
    const firstNodeId = scopedId(result.runId, 'node_a');
    const roleRun = await repositories.getLatestRoleRunForNode(
      result.runId,
      firstNodeId,
    );
    expect(roleRun?.status).toBe('interrupted');
    const node = await repositories.getNode(firstNodeId);
    expect(node?.status).toBe('interrupted');

    db.close();
  });

  it('workflow-job-executor on shutdown: returns interrupted without setting session cancelled or emitting turn/end{cancelled}', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const repositories = createRepositories(db, writeQueue);
    const audit = createAuditLogger({ repositories, db, writeQueue });
    const sessions = createSessionEventStore(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();

    const session = await seedRunAndSession(repositories, sessions, 'run_wf_shutdown');
    const shutdownCtrl = new AbortController();
    shutdownCtrl.abort(JOB_ABORT_REASON_SHUTDOWN);

    const executor = createWorkflowJobExecutor({
      repositories,
      audit,
      projectContext: { projectRoot: '/tmp/tekon-test' },
      sessions,
      bus,
      registry,
      engineFactory: async () => ({
        async executePreparedRun() {
          const err = new Error('aborted');
          err.name = 'AbortError';
          throw err;
        },
        async resumeRun() {
          throw new Error('not used');
        },
      }),
    });

    const ctx: JobExecutionContext = {
      job: {
        id: 'job_wf_shutdown',
        sessionId: session.id,
        kind: 'workflow-run',
        status: 'running',
        owner: 'worker_test',
        lease: new Date().toISOString(),
        abortState: 'none',
        checkpoint: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      signal: shutdownCtrl.signal,
      pauseRequested: () => false,
      checkpoint: async () => {},
    };

    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe('interrupted');

    // Session is NOT marked cancelled or failed
    const currentSession = await sessions.getSession(session.id);
    expect(currentSession?.status).toBe('active');

    // No turn/end with status cancelled was emitted, no agent/error
    const events = await sessions.listEventsSince(session.id, 0);
    const turnEnd = events.find((e) => e.type === 'turn/end');
    expect(turnEnd).toBeUndefined();
    const agentError = events.find((e) => e.type === 'agent/error');
    expect(agentError).toBeUndefined();

    db.close();
  });

  it('automation-job-executor on shutdown: returns interrupted instead of failed and does not emit agent/error', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue();
    const repositories = createRepositories(db, writeQueue);
    const audit = createAuditLogger({ repositories, db, writeQueue });
    const sessions = createSessionEventStore(db, writeQueue);
    const bus = createSessionEventBus();

    const session = await seedRunAndSession(repositories, sessions, 'run_auto_shutdown');
    const shutdownCtrl = new AbortController();
    shutdownCtrl.abort(JOB_ABORT_REASON_SHUTDOWN);

    const executor = createAutomationJobExecutor({
      repositories,
      audit,
      sessions,
      bus,
      projectRoot: '/tmp/tekon-test',
    });

    const ctx: JobExecutionContext = {
      job: {
        id: 'job_auto_shutdown',
        sessionId: session.id,
        kind: 'delivery-auto-prepare',
        status: 'running',
        owner: 'worker_test',
        lease: new Date().toISOString(),
        abortState: 'none',
        checkpoint: null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      signal: shutdownCtrl.signal,
      pauseRequested: () => false,
      checkpoint: async () => {},
    };

    const outcome = await executor.execute(ctx);
    expect(outcome.status).toBe('interrupted');

    // Does NOT emit agent/error on shutdown abort
    const events = await sessions.listEventsSince(session.id, 0);
    const agentError = events.find((e) => e.type === 'agent/error');
    expect(agentError).toBeUndefined();

    db.close();
  });

  it('P0-ARCH-02 / §4-G: database write fence rejects late repository writes from uncooperative executor after shutdown deadline', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const writeQueue = createWriteQueue({ isClosed: () => db.isClosed() });
    const repositories = createRepositories(db, writeQueue);
    const sessions = createSessionEventStore(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);
    const bus = createSessionEventBus();
    const registry = createSubprocessRegistry();

    let executorStarted = false;
    let attemptLateWrite!: () => Promise<unknown>;

    // Uncooperative executor that hangs on execution, ignores abort,
    // and provides a late write closure that directly invokes repository methods.
    const uncooperativeExecutor: JobExecutor = {
      execute() {
        executorStarted = true;
        attemptLateWrite = async () => {
          return repositories.createWorkflowInstance({
            id: 'run_late_write',
            projectId: 'proj_late',
            demandId: 'demand_late',
            status: 'running',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          });
        };
        return new Promise(() => {
          // never settles, ignores abort signal
        });
      },
    };

    const runner = createJobRunner({
      jobs,
      sessions,
      bus,
      registry,
      executor: uncooperativeExecutor,
      pollIntervalMs: 2,
      stopSettleTimeoutMs: 10,
      stopHardTimeoutMs: 50,
      workerId: 'worker_late_writer',
    });
    runners.push(runner);

    const workspace = await sessions.getOrCreateDefaultWorkspace('/tmp/stop-late');
    const session = await sessions.createSession({
      workspaceId: workspace.id,
      title: 'uncooperative-late',
      profile: 'human-web',
      runId: 'run_uncooperative_late',
    });
    await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executorStarted);

    // Stop runner (returns within hard deadline) and activate DB write fence (shutdown sequence)
    await runner.stop();
    db.markClosed();

    // The uncooperative executor attempts a direct repository write after deadline
    await expect(attemptLateWrite()).rejects.toThrow(/closed/i);

    // Verify repository layer: no late write landed
    const lateInstance = await repositories.getWorkflowInstance('run_late_write');
    expect(lateInstance).toBeNull();

    db.close();
  });
});