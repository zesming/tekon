import { randomUUID } from 'node:crypto';

import type { Job, JobRunner, JobStatus } from '../types/session-contract.js';
import type { SessionEventBus } from './event-bus.js';
import type { JobRepository, SessionEventStore } from './session-store.js';
import type { SubprocessRegistry } from './subprocess-registry.js';

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
 * start, and fences every terminal write on ownership so a zombie executor
 * cannot flip a job that was requeued/cancelled underneath it.
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
   * row. The in-memory flag is process-local and only set for owned jobs;
   * the owner===workerId path is byte-identical to the old owner-fenced
   * version (web single-process semantics unchanged).
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
  const workerId =
    deps.workerId ?? `web-${process.pid}-${randomUUID().slice(0, 8)}`;

  // In-memory execution state, keyed by jobId.
  const controllers = new Map<string, AbortController>();
  const pauseFlags = new Set<string>();
  const heartbeats = new Map<string, NodeJS.Timeout>();
  const pending = new Set<Promise<void>>();
  let pollTimer: NodeJS.Timeout | null = null;
  let stopped = true;

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
    const updated = await jobs.updateJob(jobId, { checkpoint: value });
    if (!updated) {
      throw new JobFencingError(jobId, 'job not found');
    }
    if (updated.owner !== workerId) {
      throw new JobFencingError(
        jobId,
        `owner is ${updated.owner ?? 'null'}, expected ${workerId}`,
      );
    }
    // MUST-FIX 2: `paused` is allowed — a pause frequently lands while a node
    // is executing, and rejecting the checkpoint at node completion would turn
    // the in-flight job into a deterministic failure.
    if (updated.status !== 'running' && updated.status !== 'paused') {
      throw new JobFencingError(
        jobId,
        `status ${updated.status} is not checkpointable`,
      );
    }
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
  ): Promise<void> {
    clearHeartbeat(job.id);
    controllers.delete(job.id);
    pauseFlags.delete(job.id);

    // SHOULD13: re-read and fence on ownership before writing the terminal
    // state. A zombie executor whose lease expired (job requeued / reclaimed /
    // cancelled underneath it) must not flip the job to done/failed.
    const current = await jobs.get(job.id);
    if (!current || current.owner !== workerId) {
      return;
    }

    const terminalStatus: JobStatus = failure
      ? 'failed'
      : result && SETTLEABLE_STATUSES.includes(result.status)
        ? result.status
        : 'failed';

    await jobs.updateJob(job.id, {
      status: terminalStatus,
      abortState: 'stopped',
    });
    await notifySettled(
      current.sessionId,
      job.id,
      current.kind,
      terminalStatus,
    );
  }

  async function runJob(job: Job): Promise<void> {
    const controller = new AbortController();
    controllers.set(job.id, controller);

    // Gap C: the heartbeat follows whether the background task is in flight,
    // NOT job.status — running/paused/cancelling all renew until the executor
    // settles. Pausing must never stop lease renewal, otherwise a live paused
    // job would look stale and get requeued (a live paused job is always
    // heartbeating, so a paused job with an expired lease is necessarily a
    // crashed worker).
    const heartbeat = setInterval(() => {
      if (!heartbeats.has(job.id)) {
        return;
      }
      void jobs.updateJob(job.id, { lease: nowIso() }).catch(() => {});
    }, heartbeatMs);
    if (typeof heartbeat.unref === 'function') {
      heartbeat.unref();
    }
    heartbeats.set(job.id, heartbeat);

    const ctx: JobExecutionContext = {
      job,
      signal: controller.signal,
      pauseRequested: () => pauseFlags.has(job.id),
      checkpoint: (nodeId) => writeCheckpoint(job.id, `node:${nodeId}`),
    };

    let result: { status: JobStatus; summary?: string } | undefined;
    let failure: unknown;
    try {
      result = await executor.execute(ctx);
    } catch (error) {
      // Runner catch-all: an executor throw settles the job as failed.
      failure = error;
    }
    await settle(job, result, failure);
  }

  function spawnJob(job: Job): void {
    const task = runJob(job).catch(() => {
      // runJob has its own catch-all; this is a last-resort guard so a
      // rejected task promise never becomes an unhandled rejection.
    });
    pending.add(task);
    void task.finally(() => pending.delete(task));
  }

  async function poll(): Promise<void> {
    if (stopped) {
      return;
    }
    const job = await jobs.claimNext(workerId);
    if (job) {
      spawnJob(job);
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

    async get(jobId) {
      return jobs.get(jobId);
    },

    async requestCancel(jobId, _reason) {
      const job = await jobs.get(jobId);
      if (!job) {
        return;
      }
      // A settled job has nothing to cancel: no controller, no live
      // subprocess. Returning here keeps repeat-cancel idempotent (M2) and
      // guards the settle-vs-cancel race — without it a done/failed/cancelled
      // job would be flipped to `cancelling` (and killAll fired on a finished
      // run), then linger as "active" (findActiveByRunId → resume 409) until
      // the next start()'s recoverStale. Design §2.5 step 3 scopes the abort
      // flow to running/paused only.
      if (
        job.status === 'done' ||
        job.status === 'failed' ||
        job.status === 'cancelled'
      ) {
        return;
      }
      if (job.owner == null) {
        // M3: a queued job has no controller / subprocess / live lease —
        // cancel it directly without entering the abort flow (otherwise it
        // would never reach a terminal state: claimNext only picks queued
        // jobs and requeueStale only touches leased ones).
        await jobs.updateJob(jobId, {
          status: 'cancelled',
          abortState: 'stopped',
        });
        await notifySettled(job.sessionId, jobId, job.kind, 'cancelled');
        return;
      }

      await jobs.updateJob(jobId, {
        status: 'cancelling',
        abortState: 'requested',
      });
      controllers.get(jobId)?.abort();
      const runId = await sessions.getRunIdBySessionId(job.sessionId);
      if (runId) {
        registry.killAll(runId, 'SIGKILL');
      }
      await jobs.updateJob(jobId, { abortState: 'propagated' });
    },

    async requestPause(jobId) {
      const job = await jobs.get(jobId);
      if (!job) {
        return;
      }
      if (job.status !== 'running' && job.status !== 'paused') {
        // Queued jobs (owner NULL) must not be persisted as paused: claimNext
        // only picks `queued` and requeueStale only touches leased jobs, so a
        // paused unclaimed job would be stranded.
        return;
      }
      // 4c M2: the in-memory pause flag is process-local — only set it when
      // this runner owns the job. Persistence is owner-independent so the
      // actual holder (this or another process) can observe `paused` on its
      // job row and relay it through its own requestPause (pauseFlags only,
      // never abort — aborting would settle the run cancelled, not paused).
      if (job.owner === workerId) {
        pauseFlags.add(jobId);
      }
      await jobs.updateJob(jobId, { status: 'paused' });
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
      stopped = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      // Wait for in-flight jobs to settle, capped at 5s. Jobs that do not
      // settle in time have their heartbeats cleared below (lease goes stale)
      // and are recovered by the next start()'s recoverStale().
      const allSettled = Promise.allSettled([...pending]);
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, STOP_SETTLE_TIMEOUT_MS);
        if (typeof timer.unref === 'function') {
          timer.unref();
        }
      });
      await Promise.race([allSettled, timeout]);
      if (timer) {
        clearTimeout(timer);
      }
      for (const jobId of [...heartbeats.keys()]) {
        clearHeartbeat(jobId);
      }
      controllers.clear();
      pauseFlags.clear();
    },

    async recoverStale() {
      return recoverStaleJobs();
    },
  };

  return runner;
}
