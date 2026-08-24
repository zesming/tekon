import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  buildModelVisibleView,
  createCommandGateway,
  createDualWriteAuditLogger,
  createDualWriteRepositories,
  createGateEngine,
  createJobRepository,
  createJobRunner,
  createMockAgentAdapter,
  createRepositories,
  createSessionDualWriteBridge,
  createSessionEventBus,
  createSessionEventStore,
  createSubprocessRegistry,
  createWorkflowEngine,
  createWorktreeManager,
  createWriteQueue,
  isWorkflowTerminalError,
  mapAuditEventToSessionEvent,
  MAPPED_AUDIT_EVENT_TYPES,
  migrateDatabase,
  openTekonDatabase,
  writeWorkflowTerminal,
  type AgentAdapter,
  type DurableJobRunner,
  type JobExecutor,
  type JobStatus,
  type SessionEventStore,
  type TekonDatabase,
  type WorkflowInstance,
} from '../../src/index.js';

// Phase 1 S9 e2e (design §4.3): real db + dual-write composition root + durable
// job runner + mock/latch adapter. Exercises the run/cancel/crash journeys and
// the audit↔session_events reconciliation. SHOULD5: the executor/engine are
// built through the dual-write wrappers so every session event has a real
// source. SHOULD19: the cancel journeys use a latch adapter (the plain mock
// adapter runs synchronously and never observes the signal mid-flight).

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error('waitFor: condition not met before timeout');
    }
    await sleep(10);
  }
}

function createGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-phase1-job-e2e-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], { cwd: repoPath });
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  mkdirSync(join(repoPath, '.tekon'), { recursive: true });
  return repoPath;
}

/** Minimal single-node schema-gated workflow (mock adapter satisfies it). */
function singleNodeWorkflow() {
  return {
    id: 'phase1-job-e2e',
    name: 'Phase 1 Job E2E',
    version: 1,
    retryPolicy: {
      maxAttempts: 1,
      maxRetries: 0,
      backoffMs: 0,
      strategy: 'fixed' as const,
      onExhausted: 'block' as const,
    },
    phases: [
      {
        id: 'rd',
        name: 'RD',
        dependsOn: [],
        parallel: false,
        nodes: [
          {
            id: 'rd-node',
            role: 'rd' as const,
            inputs: [],
            outputs: [{ id: 'code', type: 'code-changes' as const }],
            gates: [{ type: 'schema' as const, artifactType: 'prd' as const }],
            dependsOn: [],
          },
        ],
      },
    ],
  };
}

/**
 * SHOULD19: a latch adapter that blocks inside runAgent until the test releases
 * it, so cancel/crash can land while the agent is genuinely in flight (the plain
 * mock adapter runs synchronously and never observes the signal). On release it
 * either returns cancelled (if the signal fired) or delegates to the mock so the
 * run can complete. `entered` resolves once the agent is executing.
 */
function createLatchAdapter(): {
  adapter: AgentAdapter;
  entered: Promise<void>;
  release: () => void;
} {
  const mock = createMockAgentAdapter();
  let releaseFn: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  let markEntered: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const adapter: AgentAdapter = {
    async runAgent(input) {
      markEntered();
      await gate;
      if (input.signal?.aborted) {
        return {
          provider: 'mock',
          exitCode: null,
          durationMs: 0,
          outputFiles: [],
          cancelled: true,
        };
      }
      return mock.runAgent(input);
    },
  };
  return { adapter, entered, release: () => releaseFn() };
}

// ---------------------------------------------------------------------------
// Composition root: dual-write repositories/audit + engine + runner + executor.
// Mirrors packages/web/src/server/api/{root,job-executor}.ts, minus HTTP.
// ---------------------------------------------------------------------------
interface Harness {
  db: TekonDatabase;
  repoPath: string;
  sessions: SessionEventStore;
  bus: ReturnType<typeof createSessionEventBus>;
  jobs: ReturnType<typeof createJobRepository>;
  jobRunner: DurableJobRunner;
  registry: ReturnType<typeof createSubprocessRegistry>;
  /** Dual-write repositories (same instance the web context.repositories uses). */
  repositories: ReturnType<typeof createDualWriteRepositories>;
  buildEngine: (runId: string, signal: AbortSignal) => ReturnType<typeof createWorkflowEngine>;
  close: () => Promise<void>;
}

function createHarness(input: {
  repoPath: string;
  adapter: AgentAdapter;
}): Harness {
  const db = openTekonDatabase({
    filename: join(input.repoPath, '.tekon', 'tekon.sqlite'),
  });
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  const repositories = createRepositories(db, writeQueue);
  const audit = createAuditLogger({ repositories, db, writeQueue });
  const sessions = createSessionEventStore(db, writeQueue);
  const jobs = createJobRepository(db, writeQueue);
  const bus = createSessionEventBus();
  const registry = createSubprocessRegistry();

  const bridge = createSessionDualWriteBridge({ sessions, bus });
  const dualRepositories = createDualWriteRepositories(repositories, bridge);
  const dualAudit = createDualWriteAuditLogger(audit, bridge);

  const buildEngine = (runId: string, signal: AbortSignal) => {
    const gateway = createCommandGateway({ repositories: dualRepositories });
    return createWorkflowEngine({
      repoPath: input.repoPath,
      dataDir: '.tekon',
      repositories: dualRepositories,
      audit: dualAudit,
      adapter: input.adapter,
      agentProvider: 'mock',
      agentConfigSummary: { provider: 'mock' },
      gateEngine: createGateEngine({ repositories: dualRepositories, gateway }),
      worktreeManager: createWorktreeManager({
        repositories: dualRepositories,
        gateway,
      }),
      registry,
      signal,
      // Phase 2 S3: mirror the web executor — agent-loop step events flow
      // through the same dual-write bridge (best-effort).
      agentEventSink: bridge,
    });
  };

  // Executor: faithfully mirrors the web workflow job executor
  // (packages/web/src/server/api/job-executor.ts) — same status→session
  // mapping AND the same turn/end emission on every terminal path, so a
  // regression there (dropped turn/end, wrong interrupted mapping) is caught
  // here too. The web executor additionally does redactSecrets on error text
  // and wraps the gateway with registry/signal; those are covered by web tests.
  const emit = async (
    sessionId: string,
    type: string,
    payload: Record<string, unknown>,
    modelVisible = false,
  ) => {
    const event = await sessions.appendEvent({
      sessionId,
      type,
      payload,
      modelVisible,
    });
    bus.publish(event);
  };
  const settleByStatus = async (
    sessionId: string,
    runId: string,
    workflow: WorkflowInstance,
    aborted: boolean,
  ): Promise<{ status: JobStatus }> => {
    if (aborted || workflow.status === 'cancelled') {
      await sessions.updateSessionStatus(sessionId, 'cancelled');
      await emit(sessionId, 'turn/end', { runId, status: 'cancelled' });
      return { status: 'cancelled' };
    }
    switch (workflow.status) {
      case 'passed':
        await sessions.updateSessionStatus(sessionId, 'done');
        // D4 (phase 2 S3): synthetic "Run passed." removed — real per-node
        // assistant/message now comes from the step-event bridge.
        await emit(sessionId, 'turn/end', { runId, status: 'passed' });
        return { status: 'done' };
      case 'paused': {
        const decisions = await repositories.listHumanDecisions(runId);
        const hasPending = decisions.some((d) => d.status === 'pending');
        await sessions.updateSessionStatus(
          sessionId,
          hasPending ? 'awaiting-approval' : 'idle',
        );
        await emit(sessionId, 'turn/end', { runId, status: 'paused' });
        return { status: 'done' };
      }
      case 'blocked':
        await sessions.updateSessionStatus(sessionId, 'awaiting-input');
        await emit(sessionId, 'turn/end', { runId, status: 'blocked' });
        return { status: 'done' };
      case 'interrupted':
        await sessions.updateSessionStatus(sessionId, 'failed');
        await emit(sessionId, 'agent/error', { runId, status: 'interrupted' });
        await emit(sessionId, 'turn/end', { runId, status: 'interrupted' });
        return { status: 'failed' };
      default:
        await sessions.updateSessionStatus(sessionId, 'idle');
        await emit(sessionId, 'turn/end', { runId, status: workflow.status });
        return { status: 'done' };
    }
  };
  const executor: JobExecutor = {
    async execute(ctx) {
      const runId = await sessions.getRunIdBySessionId(ctx.job.sessionId);
      if (!runId) {
        await sessions.updateSessionStatus(ctx.job.sessionId, 'failed');
        return { status: 'failed' };
      }
      await sessions.updateSessionStatus(ctx.job.sessionId, 'active');
      await emit(ctx.job.sessionId, 'turn/start', { runId, kind: ctx.job.kind });
      try {
        const engine = buildEngine(runId, ctx.signal);
        const workflow: WorkflowInstance =
          ctx.job.kind === 'workflow-resume'
            ? (await engine.resumeRun(runId)).workflow
            : await engine.executePreparedRun(runId);
        return await settleByStatus(
          ctx.job.sessionId,
          runId,
          workflow,
          ctx.signal.aborted,
        );
      } catch (error) {
        if (ctx.signal.aborted) {
          await writeWorkflowTerminal(
            dualRepositories,
            runId,
            'cancelled',
            null,
          ).catch(() => {});
          await sessions.updateSessionStatus(ctx.job.sessionId, 'cancelled');
          await emit(ctx.job.sessionId, 'turn/end', {
            runId,
            status: 'cancelled',
          });
          return { status: 'cancelled' };
        }
        if (isWorkflowTerminalError(error)) {
          await emit(ctx.job.sessionId, 'turn/end', { runId, status: 'terminal' });
          return { status: 'cancelled' };
        }
        await sessions.updateSessionStatus(ctx.job.sessionId, 'failed');
        await emit(ctx.job.sessionId, 'agent/error', {
          runId,
          message: String(error),
        });
        await emit(ctx.job.sessionId, 'turn/end', { runId, status: 'failed' });
        return { status: 'failed' };
      }
    },
  };

  const jobRunner = createJobRunner({
    jobs,
    sessions,
    bus,
    registry,
    executor,
    pollIntervalMs: 20,
    leaseTtlMs: 500,
    heartbeatMs: 100,
  });

  return {
    db,
    repoPath: input.repoPath,
    sessions,
    bus,
    jobs,
    jobRunner,
    registry,
    repositories: dualRepositories,
    buildEngine,
    async close() {
      await jobRunner.stop();
      db.close();
    },
  };
}

/** Mirror the web project.cancel route: idempotent terminal write + single
 * emission of agent/cancel-requested + agent/cancelled + requestCancel on the
 * active job (MF1). Returns whether the cancel won the race (written). */
async function cancelRun(h: Harness, runId: string): Promise<boolean> {
  let written = false;
  try {
    const result = await writeWorkflowTerminal(h.repositories, runId, 'cancelled');
    written = result.written;
  } catch (error) {
    if (isWorkflowTerminalError(error)) return false;
    throw error;
  }
  const session = await h.sessions.findSessionByRunId(runId);
  if (!written) return false;
  if (session) {
    const requested = await h.sessions.appendEvent({
      sessionId: session.id,
      type: 'agent/cancel-requested',
      payload: { runId },
    });
    h.bus.publish(requested);
  }
  const active = await h.jobs.findActiveByRunId(runId);
  if (active) {
    await h.jobRunner.requestCancel(active.id, 'e2e cancel');
  }
  if (session) {
    await h.sessions.updateSessionStatus(session.id, 'cancelled');
    const cancelled = await h.sessions.appendEvent({
      sessionId: session.id,
      type: 'agent/cancelled',
      payload: { runId },
    });
    h.bus.publish(cancelled);
  }
  return true;
}

/** Bind a session to a run and enqueue a job of the given kind. Mirrors the
 * web project.run/resume routers: after createSession, explicitly emit the M1
 * session-lifecycle events (dual-write skips prepareRun's run.started because no
 * session existed yet — the router re-emits workflow/started). */
async function enqueueRun(
  h: Harness,
  runId: string,
  kind: 'workflow-run' | 'workflow-resume',
  demandText = 'e2e demand',
): Promise<{ sessionId: string; jobId: string }> {
  const workspace = await h.sessions.getOrCreateDefaultWorkspace(h.repoPath);
  const session = await h.sessions.createSession({
    workspaceId: workspace.id,
    title: null,
    profile: 'human-web',
    runId,
  });
  if (kind === 'workflow-run') {
    for (const event of [
      { type: 'session/created', payload: { runId, sessionId: session.id } },
      { type: 'workflow/started', payload: { runId, kind: 'workflow' } },
      // Mirror the web router: the user's message is model-visible (§13.6).
      {
        type: 'user/message',
        payload: { runId, text: demandText },
        modelVisible: true,
      },
    ]) {
      const appended = await h.sessions.appendEvent({
        sessionId: session.id,
        type: event.type,
        payload: event.payload,
        modelVisible: (event as { modelVisible?: boolean }).modelVisible ?? false,
      });
      h.bus.publish(appended);
    }
  }
  const job = await h.jobRunner.enqueue({ sessionId: session.id, kind });
  return { sessionId: session.id, jobId: job.id };
}

function sessionEventTypes(db: TekonDatabase, sessionId: string): string[] {
  return (
    db
      .prepare(
        'select type from session_events where session_id = ? order by seq',
      )
      .all(sessionId) as Array<{ type: string }>
  ).map((r) => r.type);
}

describe('phase 1 session/job e2e (S9)', () => {
  it('journey 1: run-to-passed drives the run and emits the session event spine', async () => {
    const repoPath = createGitRepo();
    const h = createHarness({ repoPath, adapter: createMockAgentAdapter() });

    // prepareRun via a throwaway engine (no signal needed), then enqueue.
    const controller = new AbortController();
    const prep = await h.buildEngine('pending', controller.signal).prepareRun({
      demandText: 'Run to passed through the durable job runner.',
      mode: 'template',
      workflowSpec: singleNodeWorkflow(),
    });
    const runId = prep.runId;

    const { sessionId, jobId } = await enqueueRun(h, runId, 'workflow-run');
    h.jobRunner.start();

    await waitFor(() => {
      const row = h.db
        .prepare('select status from workflow_instances where id = ?')
        .get(runId) as { status: string } | undefined;
      return row?.status === 'passed';
    });

    // Wait for the job to settle done + the session to reach done.
    await waitFor(async () => {
      const s = await h.sessions.getSession(sessionId);
      return s?.status === 'done';
    });
    await waitFor(async () => (await h.jobs.get(jobId))?.status === 'done');

    const types = sessionEventTypes(h.db, sessionId);
    // Full spine (design §4.3 journey 1). Membership is order-independent;
    // job/status is a runner lifecycle event excluded from the reconciliation.
    expect(types).toContain('session/created');
    expect(types).toContain('workflow/started');
    expect(types).toContain('user/message');
    expect(types).toContain('turn/start');
    expect(types).toContain('workflow/node-started');
    expect(types).toContain('gate/result');
    expect(types).toContain('artifact/created');
    expect(types).toContain('workflow/node-ended');
    expect(types).toContain('agent/status');
    expect(types).toContain('assistant/message');
    // turn/end closes the turn (web executor emits it on every terminal path;
    // asserting it here catches a regression that drops it).
    expect(types).toContain('turn/end');

    // Reconciliation (§4.3 step 5 / §1.2): every MAPPED audit type present for
    // this run must yield ≥1 session event, and the run-level completion must
    // Reconciliation (§4.3 step 5 / §1.2): every MAPPED audit type present for
    // this run must yield ≥1 session event, and the run-level completion must
    // NOT be double-emitted (SHOULD7: exactly one agent/status passed).
    const auditTypes = (
      h.db
        .prepare(
          'select type from audit_events where run_id = ? order by created_at, id',
        )
        .all(runId) as Array<{ type: string }>
    ).map((r) => r.type);
    const mappedPresent = auditTypes.filter((t) =>
      (MAPPED_AUDIT_EVENT_TYPES as readonly string[]).includes(t),
    );
    // At minimum run.started, node.started, node.passed, run.passed mapped.
    expect(mappedPresent).toContain('run.started');
    expect(mappedPresent).toContain('run.passed');

    // Count-equality (§4.3 step 5, stronger than membership): for each distinct
    // MAPPED audit type, the number of audit events of that type equals the
    // number of session events of its projected type — no mapped event dropped,
    // none double-emitted. This journey's mapped types are 1:1 with their
    // projections (no two audit types share a projection here), so per-type
    // count-equality is exact. run.started is special: dual-write skips it (no
    // session yet at prepareRun) and the router re-emits workflow/started once —
    // still exactly one workflow/started, so it reconciles.
    const sessionTypeCounts = (
      h.db
        .prepare(
          'select type, count(*) as n from session_events where session_id = ? group by type',
        )
        .all(sessionId) as Array<{ type: string; n: number }>
    ).reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = r.n;
      return acc;
    }, {});
    for (const auditType of new Set(mappedPresent)) {
      const mapped = mapAuditEventToSessionEvent({
        runId,
        auditType,
        auditPayload: {},
      });
      expect(mapped).not.toBeNull();
      const auditCount = mappedPresent.filter((t) => t === auditType).length;
      expect(sessionTypeCounts[mapped!.type] ?? 0).toBe(auditCount);
    }

    // No unmapped audit type leaked into a session projection type: every
    // session event type present must be an audit-mapped projection, a
    // repository-level dual-write projection (§1.2: gate/result, artifact/
    // created, approval/requested, approval/decided — sourced from the
    // repositories wrapper, not the audit mapping), or a session-lifecycle/M1
    // event. Catches an accidental new/duplicated mapping leaking into the spine.
    const projectionTypes = new Set(
      [...new Set(mappedPresent)].map(
        (t) =>
          mapAuditEventToSessionEvent({ runId, auditType: t, auditPayload: {} })!
            .type,
      ),
    );
    const repositoryProjectionTypes = new Set([
      'gate/result',
      'artifact/created',
      'approval/requested',
      'approval/decided',
    ]);
    const lifecycleTypes = new Set([
      'session/created',
      'workflow/started',
      'user/message',
      'turn/start',
      'turn/end',
      'job/status',
    ]);
    // Phase 2 S3: agent-loop step events are appended directly by the step-event
    // bridge (runAgentWithStepEvents), NOT via audit mapping. Literal enum (not
    // a `step/`/`tool/` prefix match) so a future unknown subtype still trips the
    // leak guard. assistant/message moved here from lifecycleTypes — after D4 it
    // is emitted per node by the bridge, not as a run-level synthetic message.
    const agentLoopTypes = new Set([
      'step/start',
      'step/end',
      'tool/call',
      'tool/result',
      'assistant/message',
      'agent/error',
    ]);
    for (const sessionType of Object.keys(sessionTypeCounts)) {
      expect(
        projectionTypes.has(sessionType) ||
          repositoryProjectionTypes.has(sessionType) ||
          lifecycleTypes.has(sessionType) ||
          agentLoopTypes.has(sessionType),
      ).toBe(true);
    }

    // SHOULD7: passed completion emitted exactly once (no dual-write + explicit
    // double emission).
    const passedStatusEvents = (
      h.db
        .prepare(
          `select payload from session_events
           where session_id = ? and type = 'agent/status'`,
        )
        .all(sessionId) as Array<{ payload: string }>
    ).filter((r) => {
      try {
        return (JSON.parse(r.payload) as { status?: string }).status === 'passed';
      } catch {
        return false;
      }
    });
    expect(passedStatusEvents).toHaveLength(1);

    await h.close();
  }, 30_000);

  it('journey 2: cancel mid-flight aborts the job, settles the run cancelled, emits single cancel events (MF1)', async () => {
    const repoPath = createGitRepo();
    const latch = createLatchAdapter();
    const h = createHarness({ repoPath, adapter: latch.adapter });

    const controller = new AbortController();
    const prep = await h.buildEngine('pending', controller.signal).prepareRun({
      demandText: 'Cancel me mid-flight.',
      mode: 'template',
      workflowSpec: singleNodeWorkflow(),
    });
    const runId = prep.runId;
    const { sessionId, jobId } = await enqueueRun(h, runId, 'workflow-run');
    h.jobRunner.start();

    // Wait until the agent is genuinely executing (signal observable), then cancel.
    await latch.entered;
    const won = await cancelRun(h, runId);
    expect(won).toBe(true);
    latch.release(); // let the latch adapter observe the abort and return cancelled

    await waitFor(() => {
      const row = h.db
        .prepare('select status from workflow_instances where id = ?')
        .get(runId) as { status: string } | undefined;
      return row?.status === 'cancelled';
    });
    await waitFor(async () => {
      const job = await h.jobs.get(jobId);
      return (
        job?.status === 'cancelled' ||
        job?.status === 'done' ||
        job?.status === 'failed'
      );
    });

    const job = await h.jobs.get(jobId);
    // The job must not be marked failed by the cancel (M2: idempotent terminal
    // writes after abort don't error).
    expect(job?.status).not.toBe('failed');
    expect(await repoRoleRunInterrupted(h, runId)).toBe(true);

    // MF1: exactly one cancel-requested + one cancelled; no spurious agent/error.
    const types = sessionEventTypes(h.db, sessionId);
    expect(types.filter((t) => t === 'agent/cancel-requested')).toHaveLength(1);
    expect(types.filter((t) => t === 'agent/cancelled')).toHaveLength(1);
    expect(types).not.toContain('agent/error');

    await h.close();
  }, 30_000);

  it('journey 3 (crash A): a stale running job left by a dead worker is recovered and driven to passed', async () => {
    const repoPath = createGitRepo();
    const h = createHarness({ repoPath, adapter: createMockAgentAdapter() });

    // Prepare a run, bind a session, but seed the job directly as a stale
    // running job owned by a dead worker (lease long expired) — exactly the
    // state a crash between poll and settle leaves behind. recoverStale on the
    // next start() must requeue it; the mock adapter then drives it to passed.
    const controller = new AbortController();
    const prep = await h.buildEngine('pending', controller.signal).prepareRun({
      demandText: 'Recover a crashed job.',
      mode: 'template',
      workflowSpec: singleNodeWorkflow(),
    });
    const runId = prep.runId;
    const workspace = await h.sessions.getOrCreateDefaultWorkspace(h.repoPath);
    const session = await h.sessions.createSession({
      workspaceId: workspace.id,
      title: null,
      profile: 'human-web',
      runId,
    });
    for (const event of [
      { type: 'session/created', payload: { runId } },
      { type: 'workflow/started', payload: { runId, kind: 'workflow' } },
    ]) {
      h.bus.publish(
        await h.sessions.appendEvent({
          sessionId: session.id,
          type: event.type,
          payload: event.payload,
        }),
      );
    }
    await h.jobs.enqueue({
      id: 'job_crashed_a',
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'running',
      owner: 'dead-worker',
      lease: '2020-01-01T00:00:00.000Z',
      abortState: 'none',
      checkpoint: null,
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    });

    h.jobRunner.start(); // recoverStale requeues job_crashed_a, then it runs.

    await waitFor(() => {
      const row = h.db
        .prepare('select status from workflow_instances where id = ?')
        .get(runId) as { status: string } | undefined;
      return row?.status === 'passed';
    });
    // The same job row was requeued and settled done (not duplicated).
    await waitFor(async () => (await h.jobs.get('job_crashed_a'))?.status === 'done');

    await h.close();
  }, 30_000);

  it('journey 4 (crash B): a node-mid crash is detected stale-running (interrupted), then resume drives it to passed', async () => {
    const repoPath = createGitRepo();
    // A latch adapter holds the agent mid-node so the run is "crashed while a
    // node executes": run stays running, the node's execution lease + role_run
    // stay open, no completed agent run is recorded.
    const latch = createLatchAdapter();
    const h = createHarness({ repoPath, adapter: latch.adapter });

    const controller = new AbortController();
    const prep = await h.buildEngine('pending', controller.signal).prepareRun({
      demandText: 'Crash in the middle of a node.',
      mode: 'template',
      workflowSpec: singleNodeWorkflow(),
    });
    const runId = prep.runId;
    const { jobId } = await enqueueRun(h, runId, 'workflow-run');
    h.jobRunner.start();
    await latch.entered; // node is mid-execution (lease + role_run open)

    // Simulate the crash: age the job lease (crashed worker no longer renews it)
    // and recover on the SAME durable runner. requeueStale requeues it (running
    // + abort_state='none' + stale lease → queued); on re-execution the node
    // still shows running with an open execution lease and no completed agent
    // run → stale-running detection interrupts the run (first job outcome), and
    // the executor maps interrupted → job failed (design journey B).
    await h.jobs.updateJob(jobId, { lease: '2020-01-01T00:00:00.000Z' });
    const requeued = await h.jobRunner.recoverStale();
    expect(requeued).toBeGreaterThanOrEqual(1);

    await waitFor(() => {
      const row = h.db
        .prepare('select status from workflow_instances where id = ?')
        .get(runId) as { status: string } | undefined;
      return row?.status === 'interrupted';
    });
    expect(await repoRoleRunInterrupted(h, runId)).toBe(true);
    // The recovered job settled failed (interrupted → failed). The original
    // latched execution is now a zombie; when released, its settle CANNOT flip
    // the recovered outcome because the state machine already interrupted the
    // node — a zombie engine that resumed would be rejected by the node's
    // status, not by job ownership (this harness reclaims on the SAME worker, so
    // the job-runner's owner check would pass; the safety here is the state
    // machine + the deterministic release-after-settle ordering below). Release
    // it now and let the run settle interrupted.
    await waitFor(async () => {
      const s = (await h.jobs.get(jobId))?.status;
      return s === 'failed' || s === 'cancelled';
    });
    latch.release();
    await h.close();

    // User resumes on a fresh worker (new harness, same db, non-latch adapter):
    // the interrupted run is picked up and driven to passed (design journey B
    // "two jobs": first failed on crash-detect, second resumes to completion).
    const h2 = createHarness({ repoPath, adapter: createMockAgentAdapter() });
    const workspace2 = await h2.sessions.getOrCreateDefaultWorkspace(repoPath);
    const resumeSession = await h2.sessions.createSession({
      workspaceId: workspace2.id,
      title: null,
      profile: 'human-web',
      runId,
    });
    h2.bus.publish(
      await h2.sessions.appendEvent({
        sessionId: resumeSession.id,
        type: 'workflow/started',
        payload: { runId, resumed: true, kind: 'workflow' },
      }),
    );
    await h2.jobRunner.enqueue({
      sessionId: resumeSession.id,
      kind: 'workflow-resume',
    });
    h2.jobRunner.start();

    await waitFor(() => {
      const row = h2.db
        .prepare('select status from workflow_instances where id = ?')
        .get(runId) as { status: string } | undefined;
      return row?.status === 'passed';
    });

    await h2.close();
  }, 30_000);

  it('journey 5 (§13.6): model-visible history is reconstructable from the event log', async () => {
    const repoPath = createGitRepo();
    const h = createHarness({ repoPath, adapter: createMockAgentAdapter() });

    const controller = new AbortController();
    const prep = await h.buildEngine('pending', controller.signal).prepareRun({
      demandText: 'Reconstruct model-visible history from the event log.',
      mode: 'template',
      workflowSpec: singleNodeWorkflow(),
    });
    const runId = prep.runId;
    const { sessionId } = await enqueueRun(h, runId, 'workflow-run');
    h.jobRunner.start();

    await waitFor(() => {
      const row = h.db
        .prepare('select status from workflow_instances where id = ?')
        .get(runId) as { status: string } | undefined;
      return row?.status === 'passed';
    });

    // Reconstruct the model-visible view from the full event log (what the
    // model would see on replay). NB: this proves the log is *reconstructable*
    // into a model-visible view — not that the agent's live context was derived
    // from it (promptBuilder still reads repositories; wiring is a later phase).
    const all = await h.sessions.listEventsSince(sessionId, 0);
    const view = buildModelVisibleView(all);
    const viewTypes = view.map((e) => e.type);

    // §13.6 three elements present: user/message + per-node assistant/message +
    // tool/result, all model-visible.
    expect(viewTypes).toContain('user/message');
    expect(viewTypes).toContain('assistant/message');
    expect(viewTypes).toContain('tool/result');

    // Non-vacuous: the assistant/message carries real node content (nodeId +
    // role + artifacts), not a synthetic run-level string. The executable node
    // id is namespaced with the runId, so match the node suffix.
    const assistant = view.find((e) => e.type === 'assistant/message')!;
    expect(String(assistant.payload.nodeId)).toContain('rd-node');
    expect(assistant.payload.role).toBe('rd');
    expect(Array.isArray(assistant.payload.artifacts)).toBe(true);

    // Ordering: user/message precedes the node's assistant/message.
    expect(viewTypes.indexOf('user/message')).toBeLessThan(
      viewTypes.indexOf('assistant/message'),
    );

    // Disconnect/resume replay property: splitting the log at an arbitrary seq
    // k and concatenating [0..k] ∪ (k..end] reproduces the full model-visible
    // view (SSE reconnect via sinceSeq loses/duplicates nothing).
    const k = all[Math.floor(all.length / 2)].seq;
    const head = await h.sessions.listEventsSince(sessionId, 0);
    const headUpToK = head.filter((e) => e.seq <= k);
    const tailAfterK = await h.sessions.listEventsSince(sessionId, k);
    const stitched = buildModelVisibleView([...headUpToK, ...tailAfterK]);
    expect(stitched.map((e) => e.seq)).toEqual(view.map((e) => e.seq));

    await h.close();
  }, 30_000);
});

/** True if the run's latest role_run is interrupted (SHOULD4). */
async function repoRoleRunInterrupted(h: Harness, runId: string): Promise<boolean> {
  const rows = h.db
    .prepare(
      `select status from role_runs where run_id = ? order by started_at desc`,
    )
    .all(runId) as Array<{ status: string }>;
  return rows.some((r) => r.status === 'interrupted');
}
