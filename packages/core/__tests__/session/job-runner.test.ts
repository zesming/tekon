import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createJobRepository,
  createJobRunner,
  createSessionEventBus,
  createSessionEventStore,
  createSubprocessRegistry,
  createWriteQueue,
  JobFencingError,
  migrateDatabase,
  openTekonDatabase,
  type DurableJobRunner,
  type JobExecutionContext,
  type JobExecutor,
  type JobStatus,
  type Session,
  type SessionEventStore,
} from '../../src/index.js';

const OLD_ISO = '2020-01-01T00:00:00.000Z';

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 2000,
  intervalMs = 5,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error('waitFor: condition not met before timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Executor whose executions hang until the test releases them, so cancel /
 * pause / fencing / settle races can be driven deterministically.
 */
class ControllableExecutor implements JobExecutor {
  readonly started: JobExecutionContext[] = [];

  private static instances = new Set<ControllableExecutor>();

  private pending = new Map<
    string,
    {
      resolve: (r: { status: JobStatus; summary?: string }) => void;
      reject: (e: Error) => void;
    }
  >();

  constructor() {
    ControllableExecutor.instances.add(this);
  }

  /** Release every hung execution so runner.stop() settles without the 5s cap. */
  static releaseAll(): void {
    for (const instance of ControllableExecutor.instances) {
      for (const [, pending] of instance.pending) {
        pending.resolve({ status: 'done' });
      }
      instance.pending.clear();
    }
  }

  execute(
    ctx: JobExecutionContext,
  ): Promise<{ status: JobStatus; summary?: string }> {
    this.started.push(ctx);
    return new Promise((resolve, reject) => {
      this.pending.set(ctx.job.id, { resolve, reject });
    });
  }

  release(
    jobId: string,
    result: { status: JobStatus; summary?: string } = { status: 'done' },
  ): void {
    this.pending.get(jobId)?.resolve(result);
    this.pending.delete(jobId);
  }

  fail(jobId: string, error: Error): void {
    this.pending.get(jobId)?.reject(error);
    this.pending.delete(jobId);
  }

  ctxFor(jobId: string): JobExecutionContext | undefined {
    return this.started.find((c) => c.job.id === jobId);
  }
}

function immediateExecutor(
  result: { status: JobStatus; summary?: string } = { status: 'done' },
): JobExecutor {
  return { execute: async () => result };
}

function throwingExecutor(error: Error): JobExecutor {
  return {
    execute: async () => {
      throw error;
    },
  };
}

interface SetupOptions {
  executor: JobExecutor;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  leaseTtlMs?: number;
  workerId?: string;
}

function setup(options: SetupOptions) {
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  const sessions = createSessionEventStore(db, writeQueue);
  const jobs = createJobRepository(db, writeQueue);
  const bus = createSessionEventBus();
  const registry = createSubprocessRegistry();
  const runner = createJobRunner({
    jobs,
    sessions,
    bus,
    registry,
    executor: options.executor,
    pollIntervalMs: options.pollIntervalMs ?? 5,
    heartbeatMs: options.heartbeatMs ?? 30,
    leaseTtlMs: options.leaseTtlMs ?? 30_000,
    workerId: options.workerId ?? 'worker_test',
  });
  runners.push(runner);
  return { db, sessions, jobs, bus, registry, runner };
}

const runners: DurableJobRunner[] = [];

afterEach(async () => {
  // Release hung executions first so stop() settles immediately instead of
  // waiting out its 5s cap for every test that left a job in flight.
  ControllableExecutor.releaseAll();
  for (const runner of runners.splice(0)) {
    try {
      await runner.stop();
    } catch {
      // best-effort cleanup between tests
    }
  }
});

async function seedSession(
  sessions: SessionEventStore,
  runId = 'run_1',
): Promise<Session> {
  const workspace = await sessions.getOrCreateDefaultWorkspace('/tmp/tekon-test');
  return sessions.createSession({
    workspaceId: workspace.id,
    title: 'test',
    profile: 'human-web',
    runId,
  });
}

describe('durable job runner', () => {
  it('enqueues a queued job and exposes it via get', async () => {
    const { sessions, runner } = setup({ executor: immediateExecutor() });
    const session = await seedSession(sessions);

    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    expect(job).toMatchObject({
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'queued',
      owner: null,
      lease: null,
      abortState: 'none',
      checkpoint: null,
    });
    expect(await runner.get(job.id)).toEqual(job);
    expect(await runner.get('job_missing')).toBeNull();
  });

  it('claims a queued job, runs the executor, and settles done', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);

    const running = await jobs.get(job.id);
    expect(running).toMatchObject({
      status: 'running',
      owner: 'worker_test',
    });
    expect(running?.lease).toBeTruthy();
    expect(executor.started[0]?.job.id).toBe(job.id);

    executor.release(job.id, { status: 'done', summary: 'ok' });
    await waitFor(async () => (await jobs.get(job.id))?.status === 'done');

    const done = await jobs.get(job.id);
    expect(done).toMatchObject({ status: 'done', abortState: 'stopped' });
  });

  it('publishes a job/status bus notification when a job settles', async () => {
    const executor = new ControllableExecutor();
    const { sessions, bus, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    const notifications: Array<{ type: string; payload: unknown }> = [];
    bus.subscribe(session.id, (event) => {
      notifications.push({ type: event.type, payload: event.payload });
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    executor.release(job.id);
    await waitFor(() => notifications.some((n) => n.type === 'job/status'));

    const settled = notifications.find((n) => n.type === 'job/status');
    expect(settled?.payload).toMatchObject({
      jobId: job.id,
      status: 'done',
      kind: 'workflow-run',
    });
  });

  it('marks the job failed when the executor throws (runner catch-all)', async () => {
    const { sessions, jobs, runner } = setup({
      executor: throwingExecutor(new Error('boom')),
    });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(async () => (await jobs.get(job.id))?.status === 'failed');
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'failed',
      abortState: 'stopped',
    });
  });

  it('M3: requestCancel on a queued job (owner NULL) cancels it directly without touching controller/registry', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, registry, runner } = setup({ executor });
    const killSpy = vi.spyOn(registry, 'killAll');
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    // Runner not started: the job stays queued (owner NULL).
    await runner.requestCancel(job.id, 'user changed mind');

    const cancelled = await jobs.get(job.id);
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
      owner: null,
    });
    expect(executor.started).toHaveLength(0);
    expect(killSpy).not.toHaveBeenCalled();
  });

  it('requestCancel on an already-terminal job is a no-op (idempotent repeat-cancel, no killAll)', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, registry, runner } = setup({ executor });
    const killSpy = vi.spyOn(registry, 'killAll');
    const session = await seedSession(sessions, 'run_terminal');

    // A job that already settled done, but (like every settled job) still
    // carries its owner. Without a terminal guard requestCancel would flip it
    // to cancelling + fire killAll on a finished run, then leave it "active"
    // (findActiveByRunId → resume 409) until the next recoverStale.
    const doneJob = await jobs.enqueue({
      id: 'job_done',
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'done',
      owner: 'worker_test',
      lease: new Date().toISOString(),
      abortState: 'stopped',
      checkpoint: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await runner.requestCancel(doneJob.id, 'repeat cancel');

    expect(await jobs.get(doneJob.id)).toMatchObject({
      status: 'done',
      abortState: 'stopped',
    });
    expect(killSpy).not.toHaveBeenCalled();
    expect(await jobs.findActiveByRunId('run_terminal')).toBeNull();
  });

  it('requestCancel on a running job aborts the controller, kills subprocesses, and settles cancelled', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, registry, runner } = setup({ executor });
    const killSpy = vi.spyOn(registry, 'killAll');
    const session = await seedSession(sessions, 'run_cancel');
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    const ctx = executor.ctxFor(job.id);
    expect(ctx).toBeDefined();

    await runner.requestCancel(job.id, 'governance');

    // Abort propagated to the in-memory controller.
    expect(ctx?.signal.aborted).toBe(true);
    // Subprocess registry killed by runId (resolved from the session).
    expect(killSpy).toHaveBeenCalledWith('run_cancel', 'SIGKILL');
    // Job is mid-cancel with abort propagated.
    const cancelling = await jobs.get(job.id);
    expect(cancelling).toMatchObject({
      status: 'cancelling',
      abortState: 'propagated',
    });

    // Executor observes the abort and settles cancelled.
    executor.release(job.id, { status: 'cancelled' });
    await waitFor(async () => (await jobs.get(job.id))?.status === 'cancelled');
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
  });

  it('requestPause sets the pause flag, persists status=paused, and the job settles done at the boundary', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    const ctx = executor.ctxFor(job.id);

    await runner.requestPause(job.id);

    expect(ctx?.pauseRequested()).toBe(true);
    expect(await jobs.get(job.id)).toMatchObject({ status: 'paused' });

    // Engine reaches the next node boundary and settles (mapped to done).
    executor.release(job.id, { status: 'done' });
    await waitFor(async () => (await jobs.get(job.id))?.status === 'done');
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'done',
      abortState: 'stopped',
    });
  });

  it('4c M2: requestPause persists status=paused for a running job owned by ANOTHER worker (cross-owner)', async () => {
    // Scenario: `tekon pause` (this runner) targets a run held by another
    // process (owner=worker_web). The pause MUST land on the job row so the
    // holder can observe it; the in-memory pause flag of THIS runner is
    // irrelevant (the holder sets its own flag when it observes the row).
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({
      executor,
      workerId: 'worker_cli',
    });
    const session = await seedSession(sessions, 'run_cross_owner_pause');
    const foreign = await jobs.enqueue({
      id: 'job_foreign_running',
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'running',
      owner: 'worker_web',
      lease: new Date().toISOString(),
      abortState: 'none',
      checkpoint: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await runner.requestPause(foreign.id);

    const paused = await jobs.get(foreign.id);
    expect(paused).toMatchObject({
      status: 'paused',
      owner: 'worker_web',
    });
  });

  it('4c M2: requestPause on a queued job (owner NULL) stays a no-op — an unclaimed job must not be stranded in paused', async () => {
    // claimNext only picks `queued` jobs; persisting `paused` on an unclaimed
    // job would strand it forever (requeueStale only touches leased jobs).
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions, 'run_queued_pause');
    const queued = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    await runner.requestPause(queued.id);

    expect(await jobs.get(queued.id)).toMatchObject({
      status: 'queued',
      owner: null,
    });
  });

  it('4c M2: requestPause on a foreign already-paused job is idempotent (stays paused)', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions, 'run_foreign_paused');
    const foreign = await jobs.enqueue({
      id: 'job_foreign_paused',
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'paused',
      owner: 'worker_web',
      lease: new Date().toISOString(),
      abortState: 'none',
      checkpoint: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    await runner.requestPause(foreign.id);

    expect(await jobs.get(foreign.id)).toMatchObject({
      status: 'paused',
      owner: 'worker_web',
    });
  });

  it('checkpoint persists node:<nodeId> while the job is running', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    const ctx = executor.ctxFor(job.id);

    await ctx?.checkpoint('node_1');
    expect(await jobs.get(job.id)).toMatchObject({ checkpoint: 'node:node_1' });

    await ctx?.checkpoint('node_2');
    expect(await jobs.get(job.id)).toMatchObject({ checkpoint: 'node:node_2' });
  });

  it('checkpoint fencing: throws JobFencingError when the owner changed', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    const ctx = executor.ctxFor(job.id);

    // Another worker takes over ownership (e.g. after a stale requeue + reclaim).
    await jobs.updateJob(job.id, { owner: 'worker_other' });

    await expect(ctx?.checkpoint('node_x')).rejects.toBeInstanceOf(
      JobFencingError,
    );
  });

  it('MUST-FIX 2: checkpoint does NOT throw while status=paused (pause lands mid-node)', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    const ctx = executor.ctxFor(job.id);

    await runner.requestPause(job.id);
    expect(await jobs.get(job.id)).toMatchObject({ status: 'paused' });

    // Node completes after pause landed; checkpoint must accept paused.
    await expect(ctx?.checkpoint('node_paused')).resolves.toBeUndefined();
    expect(await jobs.get(job.id)).toMatchObject({
      status: 'paused',
      checkpoint: 'node:node_paused',
    });
  });

  it('checkpoint fencing: throws JobFencingError when status left running/paused (e.g. reclaimed as cancelling)', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    const ctx = executor.ctxFor(job.id);

    // Owner unchanged, but the job moved to a non-checkpointable status.
    await jobs.updateJob(job.id, { status: 'cancelling' });

    await expect(ctx?.checkpoint('node_y')).rejects.toBeInstanceOf(
      JobFencingError,
    );
  });

  it('Gap C: heartbeat keeps renewing the lease while paused (live paused is never stale)', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({
      executor,
      heartbeatMs: 30,
    });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);

    const leaseAtStart = (await jobs.get(job.id))?.lease;
    expect(leaseAtStart).toBeTruthy();
    await sleep(120);
    const leaseWhileRunning = (await jobs.get(job.id))?.lease;
    expect(leaseWhileRunning).toBeTruthy();
    expect(leaseWhileRunning! > leaseAtStart!).toBe(true);

    await runner.requestPause(job.id);
    expect(await jobs.get(job.id)).toMatchObject({ status: 'paused' });

    await sleep(120);
    const leaseWhilePaused = (await jobs.get(job.id))?.lease;
    expect(leaseWhilePaused).toBeTruthy();
    // Red line: renewal continues after status flipped to paused.
    expect(leaseWhilePaused! > leaseWhileRunning!).toBe(true);
    // A live paused job is not recoverable as stale.
    const result = await jobs.requeueStale(
      new Date(Date.now() - 30_000).toISOString(),
    );
    expect(result).toEqual({ requeued: 0, cancelled: 0 });
    expect(await jobs.get(job.id)).toMatchObject({ status: 'paused' });

    executor.release(job.id);
    await waitFor(async () => (await jobs.get(job.id))?.status === 'done');
  });

  it('recoverStale requeues stale running jobs and cancels stale cancel-requested jobs (M4/M2)', async () => {
    const { sessions, jobs, runner } = setup({ executor: immediateExecutor() });
    const session = await seedSession(sessions);

    const staleRunning = await jobs.enqueue({
      id: 'job_stale_running',
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'running',
      owner: 'dead_worker',
      lease: OLD_ISO,
      abortState: 'none',
      checkpoint: null,
      createdAt: OLD_ISO,
      updatedAt: OLD_ISO,
    });
    const staleCancelRequested = await jobs.enqueue({
      id: 'job_stale_cancel',
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'cancelling',
      owner: 'dead_worker',
      lease: OLD_ISO,
      abortState: 'requested',
      checkpoint: null,
      createdAt: OLD_ISO,
      updatedAt: OLD_ISO,
    });
    const stalePaused = await jobs.enqueue({
      id: 'job_stale_paused',
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'paused',
      owner: 'dead_worker',
      lease: OLD_ISO,
      abortState: 'none',
      checkpoint: null,
      createdAt: OLD_ISO,
      updatedAt: OLD_ISO,
    });
    const fresh = await jobs.enqueue({
      id: 'job_fresh',
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'running',
      owner: 'worker_test',
      lease: new Date().toISOString(),
      abortState: 'none',
      checkpoint: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const recovered = await runner.recoverStale();
    expect(recovered).toBe(3);

    expect(await jobs.get(staleRunning.id)).toMatchObject({
      status: 'queued',
      owner: null,
      lease: null,
      abortState: 'none',
    });
    expect(await jobs.get(stalePaused.id)).toMatchObject({
      status: 'queued',
      owner: null,
      lease: null,
    });
    expect(await jobs.get(staleCancelRequested.id)).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
      owner: null,
      lease: null,
    });
    expect(await jobs.get(fresh.id)).toMatchObject({
      status: 'running',
      owner: 'worker_test',
    });
  });

  it('start() recovers stale jobs before polling, then drives the recovered job to done', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const stale = await jobs.enqueue({
      id: 'job_stale',
      sessionId: session.id,
      kind: 'workflow-run',
      status: 'running',
      owner: 'dead_worker',
      lease: OLD_ISO,
      abortState: 'none',
      checkpoint: null,
      createdAt: OLD_ISO,
      updatedAt: OLD_ISO,
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);
    expect(executor.started[0]?.job.id).toBe(stale.id);
    expect(await jobs.get(stale.id)).toMatchObject({
      status: 'running',
      owner: 'worker_test',
    });

    executor.release(stale.id);
    await waitFor(async () => (await jobs.get(stale.id))?.status === 'done');
  });

  it('SHOULD13: settle is discarded when the owner changed (zombie executor cannot flip the job)', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, bus, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    const notifications: string[] = [];
    bus.subscribe(session.id, (event) => notifications.push(event.type));

    runner.start();
    await waitFor(() => executor.started.length === 1);

    // Ownership moves to another worker while the zombie is still executing.
    await jobs.updateJob(job.id, { owner: 'worker_other' });

    executor.release(job.id, { status: 'done' });
    await sleep(100);

    // The zombie's settle was discarded: status is not flipped to done and no
    // job/status notification was emitted.
    const after = await jobs.get(job.id);
    expect(after?.status).toBe('running');
    expect(after?.owner).toBe('worker_other');
    expect(notifications).not.toContain('job/status');
  });

  it('stop() waits for in-flight jobs to settle before returning', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);
    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });

    runner.start();
    await waitFor(() => executor.started.length === 1);

    const stopPromise = runner.stop();
    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });
    await sleep(30);
    // The executor is still hung: stop must not have returned yet.
    expect(stopResolved).toBe(false);
    expect(await jobs.get(job.id)).toMatchObject({ status: 'running' });

    executor.release(job.id, { status: 'done' });
    await stopPromise;

    expect(stopResolved).toBe(true);
    expect(await jobs.get(job.id)).toMatchObject({ status: 'done' });
  });

  it('stop() halts polling: jobs enqueued after stop are not claimed', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);

    runner.start();
    await runner.stop();

    const job = await runner.enqueue({
      sessionId: session.id,
      kind: 'workflow-run',
    });
    await sleep(50);
    expect(await jobs.get(job.id)).toMatchObject({ status: 'queued' });
    expect(executor.started).toHaveLength(0);
  });

  it('stop() resolves immediately when no job is in flight', async () => {
    const { runner } = setup({ executor: immediateExecutor() });
    runner.start();
    await runner.stop();
    await runner.stop(); // idempotent
  });

  it('drives multiple queued jobs to completion', async () => {
    const executor = new ControllableExecutor();
    const { sessions, jobs, runner } = setup({ executor });
    const session = await seedSession(sessions);

    const a = await runner.enqueue({ sessionId: session.id, kind: 'workflow-run' });
    const b = await runner.enqueue({ sessionId: session.id, kind: 'workflow-run' });

    runner.start();
    await waitFor(() => executor.started.length === 2);

    executor.release(a.id);
    executor.release(b.id);
    await waitFor(async () => (await jobs.get(a.id))?.status === 'done');
    await waitFor(async () => (await jobs.get(b.id))?.status === 'done');
  });
});
