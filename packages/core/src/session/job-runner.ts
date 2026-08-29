import { randomUUID } from 'node:crypto';

import type { Job, JobRunner, JobStatus } from '../types/session-contract.js';
import type { SessionEventBus } from './event-bus.js';
import type { JobRepository, SessionEventStore } from './session-store.js';
import type { SubprocessRegistry } from './subprocess-registry.js';

/** Abort reason used only when a runner loses the durable job lease/owner. */
export const JOB_ABORT_REASON_OWNERSHIP_LOST =
  'tekon:job-ownership-lost' as const;

/** True when an AbortSignal fences a stale executor rather than user cancel. */
export function isJobOwnershipLostAbort(
  signal: AbortSignal | undefined,
): boolean {
  return Boolean(
    signal?.aborted && signal.reason === JOB_ABORT_REASON_OWNERSHIP_LOST,
  );
}

/** User cancellation excludes the internal ownership-loss fencing signal. */
export function isJobCancellationAbort(
  signal: AbortSignal | undefined,
): boolean {
  return Boolean(signal?.aborted && !isJobOwnershipLostAbort(signal));
}

/**
 * Thrown when a job operation detects that the job is no longer owned by this
 * runner (owner changed) or is in a status that forbids the operation. The
 * engine/executor must stop touching the job — this is what prevents a
 * double-run after a stale lease was requeued and reclaimed by another worker.
 */
export class JobFencingError extends Error {
  readonly code = 'JOB_FENCING' as const;

  constructor(
    readonly jobId: string,
    reason: string,
  ) {
    super(`job fencing check failed for ${jobId}: ${reason}`);
    this.name = 'JobFencingError';
  }
}

/** Per-job execution handle passed to the {@link JobExecutor}. */
export interface JobExecutionContext {
  readonly job: Job;
  readonly signal: AbortSignal;
  /** True once `requestPause` has been called for this job. */
  pauseRequested(): boolean;
  /**
   * Persist a node checkpoint (`node:<nodeId>`) and re-verify ownership.
   * Throws {@link JobFencingError} when the owner changed or the job left the
   * running/paused states.
   */
  checkpoint(nodeId: string): Promise<void>;
}

/** Drives a single claimed job to completion. */
export interface JobExecutor {
  execute(
    ctx: JobExecutionContext,
  ): Promise<{ status: JobStatus; summary?: string }>;
}

/**
 * Durable polling job runner (design §2.5). Claims queued jobs atomically,
 * renews a lease while the executor is in flight, recovers stale leases on
 * start, and fences every job-row write on ownership so a zombie executor
 * cannot mutate a job that was requeued/reclaimed underneath it.
 */
export interface DurableJobRunner extends JobRunner {
  /** Recover stale leases, then poll for queued jobs on an unref'd interval. */
  start(): void;
  /** Stop polling and wait for in-flight jobs to settle (5s cap). */
  stop(): Promise<void>;
  /**
   * Set the in-memory pause flag (when this runner owns the job) and persist
   * `status='paused'` — 4c M2: persistence also applies to jobs owned by
   * OTHER workers, so a cross-process pause (e.g. `tekon pause` against a
   * run held by another process) is observable by the holder via its job
   * row. The in-memory flag is process-local and only set for owned jobs.
   */
  requestPause(jobId: string): Promise<void>;
  /** Requeue/cancel jobs whose lease is older than `leaseTtlMs`. */
  recoverStale(): Promise<number>;
}

export interface CreateJobRunnerDeps {
  jobs: JobRepository;
  sessions: SessionEventStore;
  bus: SessionEventBus;
  registry: SubprocessRegistry;
  executor: JobExecutor;
  pollIntervalMs?: number;
  heartbeatMs?: number;
  leaseTtlMs?: number;
  workerId?: string;
  /**
   * Bounded wait for in-flight jobs to settle on their own during stop(),
   * before the runner escalates to explicit abort + subprocess kill. Test
   * override only; production keeps the 5s default.
   */
  stopSettleTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 200;
const DEFAULT_HEARTBEAT_MS = 10_000;
const DEFAULT_LEASE_TTL_MS = 30_000;
const STOP_SETTLE_TIMEOUT_MS = 5_000;

/** Statuses an executor may legitimately settle a job to. */
const SETTLEABLE_STATUSES: readonly JobStatus[] = [
  'done',
  'failed',
  'cancelled',
  'paused',
];

export function createJobRunner(deps: CreateJobRunnerDeps): DurableJobRunner {
  const { jobs, sessions, bus, registry, executor } = deps;
  const pollIntervalMs = deps.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
  const leaseTtlMs = deps.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const stopSettleTimeoutMs =
    deps.stopSettleTimeoutMs ?? STOP_SETTLE_TIMEOUT_MS;
  const workerId =
    deps.workerId ?? `web-${process.pid}-${randomUUID().slice(0, 8)}`;

  // In-memory execution state, keyed by jobId.
  const controllers = new Map<string, AbortController>();
  // A durable owner string is insufficient when the same worker reclaims a
  // stale job. The process-local token fences the older local generation.
  const executionTokens = new Map<string, symbol>();
  const pauseFlags = new Set<string>();
  const heartbeats = new Map<string, NodeJS.Timeout>();
  const pending = new Set<Promise<void>>();
  let pollTimer: NodeJS.Timeout | null = null;
  let stopped = true;
  let pollInFlight = false;

  const nowIso = (): string => new Date().toISOString();

  async function notifySettled(
    sessionId: string,
    jobId: string,
    kind: string,
    status: JobStatus,
  ): Promise<void> {
    try {
      const event = await sessions.appendEvent({
        sessionId,
        type: 'job/status',
        payload: { jobId, kind, status },
      });
      bus.publish(event);
    } catch {
      // Notifications are best-effort; the jobs table is the source of truth.
    }
  }

  async function writeCheckpoint(jobId: string, value: string): Promise<void> {
    // The owner/status predicate is part of the UPDATE. The previous
    // write-then-check sequence let a stale worker overwrite the new owner's
    // checkpoint before discovering that ownership had changed.
    const updated = await jobs.updateJob(
      jobId,
      { checkpoint: value },
      { owner: workerId, statuses: ['running', 'paused'] },
    );
    if (updated) {
      return;
    }

    const current = await jobs.get(jobId);
    if (!current) {
      throw new JobFencingError(jobId, 'job not found');
    }
    if (current.owner !== workerId) {
      throw new JobFencingError(
        jobId,
        `owner is ${current.owner ?? 'null'}, expected ${workerId}`,
      );
    }
    throw new JobFencingError(
      jobId,
      `status ${current.status} is not checkpointable`,
    );
  }

  function clearHeartbeat(jobId: string): void {
    const timer = heartbeats.get(jobId);
    if (timer) {
      clearInterval(timer);
      heartbeats.delete(jobId);
    }
  }

  async function settle(
    job: Job,
    result: { status: JobStatus; summary?: string } | undefined,
    failure: unknown,
    executionToken: symbol,
  ): Promise<void> {
    if (executionTokens.get(job.id) !== executionToken) {
      return;
    }

    clearHeartbeat(job.id);
    const controller = controllers.get(job.id);
    const cancelRequested = isJobCancellationAbort(controller?.signal);
    const desiredStatus: JobStatus = cancelRequested
      ? 'cancelled'
      : failure
        ? 'failed'
        : result && SETTLEABLE_STATUSES.includes(result.status)
          ? result.status
          : 'failed';

    // Owner comparison, cancellation precedence, and terminal mutation happen
    // in one SQL statement. A stale owner therefore cannot terminalize a job
    // that another process has reclaimed between a read and a write.
    const settled = await jobs.settleOwnedJob(
      job.id,
      workerId,
      desiredStatus,
    );

    controllers.delete(job.id);
    executionTokens.delete(job.id);
    pauseFlags.delete(job.id);
    if (!settled) {
      return;
    }
    await notifySettled(
      settled.sessionId,
      settled.id,
      settled.kind,
      settled.status,
    );
  }

  async function runJob(job: Job): Promise<void> {
    const executionToken = Symbol(job.id);
    const controller = new AbortController();
    executionTokens.set(job.id, executionToken);
    controllers.set(job.id, controller);

    const heartbeat = setInterval(() => {
      if (executionTokens.get(job.id) !== executionToken) {
        clearInterval(heartbeat);
        return;
      }
      void jobs
        .updateJob(
          job.id,
          { lease: nowIso() },
          {
            owner: workerId,
            statuses: ['running', 'paused', 'cancelling'],
          },
        )
        .then(async (updated) => {
          // A conditional miss means the durable row is no longer ours (or is
          // already terminal). Fence this exact local generation immediately.
          if (updated || executionTokens.get(job.id) !== executionToken) {
            return;
          }
          const activeController = controllers.get(job.id);
          if (activeController && !activeController.signal.aborted) {
            activeController.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
            const runId = await sessions.getRunIdBySessionId(job.sessionId);
            if (runId) registry.killAll(runId, 'SIGKILL');
          }
          executionTokens.delete(job.id);
          clearHeartbeat(job.id);
          controllers.delete(job.id);
          pauseFlags.delete(job.id);
        })
        .catch(() => {});
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') {
      heartbeat.unref();
    }
    heartbeats.set(job.id, heartbeat);

    const ctx: JobExecutionContext = {
      job,
      signal: controller.signal,
      pauseRequested: () =>
        executionTokens.get(job.id) === executionToken &&
        pauseFlags.has(job.id),
      checkpoint: (nodeId) => {
        if (executionTokens.get(job.id) !== executionToken) {
          throw new JobFencingError(job.id, 'execution generation changed');
        }
        return writeCheckpoint(job.id, `node:${nodeId}`);
      },
    };

    let result: { status: JobStatus; summary?: string } | undefined;
    let failure: unknown;
    try {
      result = await executor.execute(ctx);
    } catch (error) {
      failure = error;
    }
    await settle(job, result, failure, executionToken);
  }

  function spawnJob(job: Job): void {
    const task = runJob(job).catch(() => {
      // runJob has its own catch-all; this is a last-resort guard so a
      // rejected task promise never becomes an unhandled rejection.
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  async function syncOwnedControls(): Promise<void> {
    for (const [jobId, controller] of controllers) {
      const current = await jobs.get(jobId);
      if (!current || current.owner !== workerId) {
        // Ownership changed: fence the local execution and kill only processes
        // registered in this process. The new owner will continue from durable
        // state; the zombie must stop touching the workspace.
        if (!controller.signal.aborted) {
          controller.abort(JOB_ABORT_REASON_OWNERSHIP_LOST);
          const runId = current
            ? await sessions.getRunIdBySessionId(current.sessionId)
            : null;
          if (runId) registry.killAll(runId, 'SIGKILL');
        }
        // Invalidate this local generation immediately. A same-worker reclaim
        // may install a new controller/token for the same durable job id.
        executionTokens.delete(jobId);
        clearHeartbeat(jobId);
        controllers.delete(jobId);
        pauseFlags.delete(jobId);
        continue;
      }

      if (current.status === 'paused') {
        pauseFlags.add(jobId);
      }

      const cancelRequested =
        current.status === 'cancelling' ||
        current.abortState === 'requested' ||
        current.abortState === 'propagated';
      if (!cancelRequested) continue;

      if (!controller.signal.aborted) {
        controller.abort();
        const runId = await sessions.getRunIdBySessionId(current.sessionId);
        if (runId) registry.killAll(runId, 'SIGKILL');
      }
      if (current.abortState !== 'propagated') {
        await jobs.updateJob(
          jobId,
          { abortState: 'propagated' },
          { owner: workerId, statuses: ['cancelling'] },
        );
      }
    }
  }

  async function poll(): Promise<void> {
    if (stopped || pollInFlight) {
      return;
    }
    pollInFlight = true;
    try {
      // Process-local AbortControllers and registries cannot be mutated by a
      // second CLI/Web process. Observe the durable job row on every owner poll
      // and relay foreign pause/cancel requests into this process first.
      await syncOwnedControls();
      const job = await jobs.claimNext(workerId);
      if (job) {
        spawnJob(job);
      }
    } finally {
      pollInFlight = false;
    }
  }

  async function recoverStaleJobs(): Promise<number> {
    const cutoff = new Date(Date.now() - leaseTtlMs).toISOString();
    const { requeued, cancelled } = await jobs.requeueStale(cutoff);
    return requeued + cancelled;
  }

  const runner: DurableJobRunner = {
    async enqueue(input) {
      const now = nowIso();
      return jobs.enqueue({
        id: `job_${randomUUID()}`,
        sessionId: input.sessionId,
        kind: input.kind,
        status: 'queued',
        owner: null,
        lease: null,
        abortState: 'none',
        checkpoint: null,
        createdAt: now,
        updatedAt: now,
      });
    },

    async enqueueIfNoActiveByRunId(input) {
      const now = nowIso();
      return jobs.enqueueIfNoActiveByRunId(input.runId, {
        id: `job_${randomUUID()}`,
        sessionId: input.sessionId,
        kind: input.kind,
        status: 'queued',
        owner: null,
        lease: null,
        abortState: 'none',
        checkpoint: null,
        createdAt: now,
        updatedAt: now,
      });
    },

    async get(jobId) {
      return jobs.get(jobId);
    },

    async requestCancel(jobId, reason) {
      const job = await jobs.get(jobId);
      if (!job) {
        return;
      }
      // A settled job has nothing to cancel: no controller, no live
      // subprocess. Returning here keeps repeat-cancel idempotent.
      if (
        job.status === 'done' ||
        job.status === 'failed' ||
        job.status === 'cancelled'
      ) {
        return;
      }
      if (job.owner == null) {
        // A queued job has no controller/subprocess. Cancel only if it is still
        // unclaimed; if claimNext won the race, retry against the live owner.
        const cancelled = await jobs.updateJob(
          jobId,
          { status: 'cancelled', abortState: 'stopped' },
          { owner: null, statuses: ['queued'] },
        );
        if (!cancelled) {
          return runner.requestCancel(jobId, reason);
        }
        await notifySettled(
          cancelled.sessionId,
          jobId,
          cancelled.kind,
          'cancelled',
        );
        return;
      }

      // The status predicate prevents a settle-vs-cancel race from reviving a
      // terminal job as `cancelling`. Owner is intentionally not constrained:
      // cross-process cancellation targets the current owner of this job id.
      const requested = await jobs.updateJob(
        jobId,
        { status: 'cancelling', abortState: 'requested' },
        { statuses: ['running', 'paused', 'cancelling'] },
      );
      if (!requested || requested.owner !== workerId) {
        return;
      }

      const controller = controllers.get(jobId);
      controller?.abort();
      const runId = await sessions.getRunIdBySessionId(requested.sessionId);
      if (runId) {
        registry.killAll(runId, 'SIGKILL');
      }
      await jobs.updateJob(
        jobId,
        { abortState: 'propagated' },
        { owner: workerId, statuses: ['cancelling'] },
      );
    },

    async requestPause(jobId) {
      // Persist pause only while the row remains running/paused. This prevents a
      // read-then-write race from flipping a concurrently settled job back to
      // an active `paused` state.
      const paused = await jobs.updateJob(
        jobId,
        { status: 'paused' },
        { statuses: ['running', 'paused'] },
      );
      if (paused?.owner === workerId) {
        pauseFlags.add(jobId);
      }
    },

    async checkpoint(jobId, value) {
      return writeCheckpoint(jobId, value);
    },

    start() {
      if (pollTimer) {
        return;
      }
      stopped = false;
      void recoverStaleJobs().catch(() => {});
      pollTimer = setInterval(() => {
        void poll().catch(() => {});
      }, pollIntervalMs);
      if (typeof pollTimer.unref === 'function') {
        pollTimer.unref();
      }
    },

    async stop() {
      if (!pollTimer && pending.size === 0) {
        return;
      }
      // Draining: reject new claims immediately. poll() already guards on
      // `stopped`, so no new job enters `pending` after this point.
      stopped = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }

      // Phase 1: give in-flight jobs a bounded window to settle on their own.
      // A job that completes normally deletes itself from `controllers` (in
      // settle()) before its task drains from `pending`, so `controllers`
      // membership — not elapsed time — is the authoritative "still in-flight"
      // marker used by phase 2.
      const settleWithinWindow = Promise.allSettled([...pending]);
      let settleTimer: NodeJS.Timeout | undefined;
      const settleWindow = new Promise<void>((resolve) => {
        settleTimer = setTimeout(resolve, stopSettleTimeoutMs);
        if (typeof settleTimer.unref === 'function') {
          settleTimer.unref();
        }
      });
      await Promise.race([settleWithinWindow, settleWindow]);
      if (settleTimer) {
        clearTimeout(settleTimer);
      }

      // Phase 2: escalate. Any controller still present is a genuinely
      // in-flight job (completed jobs already removed theirs). Abort it and
      // kill its subprocesses so its executor stops issuing further writes.
      // Completed-but-not-yet-dequeued jobs are never touched here.
      for (const [jobId, controller] of controllers) {
        if (!controller.signal.aborted) {
          controller.abort();
        }
        const current = await jobs.get(jobId).catch(() => null);
        const sessionId = current?.sessionId;
        if (sessionId) {
          const runId = await sessions
            .getRunIdBySessionId(sessionId)
            .catch(() => null);
          if (runId) registry.killAll(runId, 'SIGKILL');
        }
      }

      // Phase 3: deterministic drain barrier. Re-await every pending task so
      // each aborted executor runs its catch/finally — including its final
      // synchronous settle() write — and dequeues from `pending` before we
      // return. Callers only close the (synchronous, better-sqlite3) database
      // after stop() resolves, so no late write can hit a closed handle.
      await Promise.allSettled([...pending]);

      for (const jobId of [...heartbeats.keys()]) {
        clearHeartbeat(jobId);
      }
      controllers.clear();
      executionTokens.clear();
      pauseFlags.clear();
    },

    async recoverStale() {
      return recoverStaleJobs();
    },
  };

  return runner;
}
