import { randomUUID } from 'node:crypto';

import type { TekonDatabase } from '../db/connection.js';
import type { WriteQueue } from '../db/write-queue.js';
import {
  SESSION_EVENT_SCHEMA_VERSION,
  type EventVisibility,
  type Job,
  type JobStatus,
  jobSchema,
  type Session,
  sessionSchema,
  type SessionEvent,
  sessionEventSchema,
  type SessionStatus,
  type Workspace,
  workspaceSchema,
} from '../types/session-contract.js';

/** Jobs that drive a workflow/goal and therefore share run controls. */
const RUN_EXECUTION_JOB_KINDS = new Set<string>([
  'workflow-run',
  'workflow-resume',
  'goal-run',
]);

/**
 * `jobs.payload` is a runner implementation detail and intentionally outside
 * the frozen `Job` contract (S14). It may be supplied at enqueue time for
 * debugging; every read path strips it via `jobSchema.parse`.
 */
export type JobEnqueueInput = Job & { payload?: Record<string, unknown> };

/** Optional compare-and-set predicate for an atomic job update. */
export interface JobUpdateCondition {
  /** Match this durable owner. `null` means the row must still be unclaimed. */
  owner?: string | null;
  /** Match one of these current statuses before applying the patch. */
  statuses?: readonly JobStatus[];
}

/**
 * A session as surfaced to the Session List read-path (phase 3 3a / phase 4 P1-04).
 * The frozen `Session` schema has no runId (session-contract.ts), so the list
 * entry extends it with the run_id column value and aggregated lastActivityAt
 * timestamp — carried through, not persisted separately on the session table.
 * Used by the web `session.list` RPC.
 */
export type SessionListEntry = Session & {
  runId: string | null;
  lastActivityAt: string;
};

export interface SessionEventStore {
  getOrCreateDefaultWorkspace(root: string): Promise<Workspace>;
  createSession(input: {
    workspaceId: string;
    title: string | null;
    profile: string;
    runId: string | null;
  }): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  findSessionByRunId(runId: string): Promise<Session | null>;
  /**
   * List a workspace's sessions ordered by last activity desc (most recent
   * event timestamp, falling back to created_at) for the Session List UI. Pure
   * SELECT, zero migration; returns [] for an unknown workspace. Carries run_id
   * and lastActivityAt from the query (SessionListEntry).
   */
  listSessions(workspaceId: string): Promise<SessionListEntry[]>;
  /**
   * Reverse lookup: the runId a session is associated with, or null when the
   * session has no run (or does not exist). The job runner uses this to map a
   * job's sessionId to the runId key used by the subprocess registry.
   */
  getRunIdBySessionId(sessionId: string): Promise<string | null>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  appendEvent(input: {
    sessionId: string;
    type: string;
    payload?: Record<string, unknown>;
    visibility?: EventVisibility;
    modelVisible?: boolean;
    sourceEventSeqs?: number[];
    correlationId?: string | null;
  }): Promise<SessionEvent>;
  listEventsSince(sessionId: string, sinceSeq: number): Promise<SessionEvent[]>;
  latestSeq(sessionId: string): Promise<number>;
  upsertProjectionCheckpoint(
    sessionId: string,
    name: string,
    lastSeq: number,
  ): Promise<void>;
}

export interface JobRepository {
  enqueue(job: JobEnqueueInput): Promise<Job>;
  get(jobId: string): Promise<Job | null>;
  findActiveByRunId(runId: string): Promise<Job | null>;
  /**
   * F5-P0-01: atomic "enqueue this job unless the run already has an active
   * job". The active-check and the INSERT run inside one `BEGIN IMMEDIATE`
   * transaction so two concurrent resumes (CLI + Web, separate connections /
   * WriteQueues) cannot both observe "no active job" and both enqueue — the
   * process-local WriteQueue only serializes writes within one process, and the
   * bare `findActiveByRunId` read in resumeRun sits outside any lock. Same
   * cross-process critical-section pattern as `appendEvent`'s seq allocation.
   * Returns `{ outcome: 'active-job', job }` (the existing active job) when one
   * already exists, else `{ outcome: 'enqueued', job }` (the newly inserted one).
   */
  enqueueIfNoActiveByRunId(
    runId: string,
    job: JobEnqueueInput,
  ): Promise<
    { outcome: 'enqueued'; job: Job } | { outcome: 'active-job'; job: Job }
  >;
  // 回收该 run 下"旧"的可安全清理 job:created_at 早于 cutoff 的 queued,以及
  // lease 早于 cutoff 的 paused;running/cancelling/新鲜 queued 不动。
  // `leaseCutoffIso` 缺省时沿用 30s 默认(= runner 默认 leaseTtlMs);
  // 自定义 leaseTtlMs 的 runner 应传入 `new Date(now - leaseTtlMs).toISOString()`,
  // 避免 stale 判定与 runner 的租约 TTL 偏离(设计 §2.2 实现注)。
  cancelStaleActiveJobs(
    runId: string,
    exceptJobId?: string,
    leaseCutoffIso?: string,
  ): Promise<number>;
  claimNext(owner: string): Promise<Job | null>;
  /**
   * Patch a job, optionally as an atomic compare-and-set. A conditional miss
   * returns null and never mutates the row.
   */
  updateJob(
    jobId: string,
    patch: Partial<
      Pick<Job, 'status' | 'owner' | 'lease' | 'abortState' | 'checkpoint'>
    >,
    condition?: JobUpdateCondition,
  ): Promise<Job | null>;
  /**
   * Atomically settle a job only while it is still owned by `owner`. A
   * concurrent cancellation request wins and is persisted as `cancelled`.
   */
  settleOwnedJob(
    jobId: string,
    owner: string,
    desiredStatus: JobStatus,
  ): Promise<Job | null>;
  requeueStale(
    leaseOlderThanIso: string,
  ): Promise<{ requeued: number; cancelled: number }>;
}

/**
 * `cancelStaleActiveJobs` treats a job as abandoned when it is older than this:
 * a paused job whose lease predates it, or a queued job whose created_at
 * predates it. Matches the runner's default lease TTL (30s), comfortably above
 * the ~200ms poll interval so a just-enqueued job is never mistaken for stale.
 */
const DEFAULT_STALE_PAUSED_LEASE_MS = 30_000;

type WorkspaceRow = {
  id: string;
  root: string;
  repo: string | null;
  branch_policy: string | null;
  permission_profile: string | null;
  created_at: string;
};

type SessionRow = {
  id: string;
  workspace_id: string;
  title: string | null;
  profile: string;
  status: string;
  run_id: string | null;
  created_at: string;
  updated_at: string;
};

type SessionListRow = SessionRow & {
  last_activity_at: string;
};

type SessionEventRow = {
  id: number;
  session_id: string;
  seq: number;
  type: string;
  version: number;
  timestamp: string;
  payload: string;
  visibility: string;
  model_visible: number;
  source_event_seqs: string;
  correlation_id: string | null;
};

type JobRow = {
  id: string;
  session_id: string;
  kind: string;
  status: string;
  owner: string | null;
  lease: string | null;
  abort_state: string;
  checkpoint: string | null;
  payload: string;
  created_at: string;
  updated_at: string;
};

export function createSessionEventStore(
  db: TekonDatabase,
  writeQueue: WriteQueue,
): SessionEventStore {
  const now = () => new Date().toISOString();

  return {
    async getOrCreateDefaultWorkspace(root) {
      return writeQueue.enqueue(() => {
        // Web and CLI open independent SQLite connections. Acquire the writer
        // lock before the lookup so first use from two processes converges on
        // one canonical workspace instead of creating split session lists.
        const tx = db.transaction(() => {
          const existing = db
            .prepare(
              `select * from workspaces
               where root = ?
               order by created_at asc, rowid asc
               limit 1`,
            )
            .get(root) as WorkspaceRow | undefined;
          if (existing) {
            return mapWorkspace(existing);
          }
          const workspace = workspaceSchema.parse({
            id: `ws_${randomUUID()}`,
            root,
            repo: null,
            branchPolicy: null,
            permissionProfile: null,
            createdAt: now(),
          });
          db.prepare(
            `insert into workspaces (id, root, repo, branch_policy, permission_profile, created_at)
             values (@id, @root, @repo, @branchPolicy, @permissionProfile, @createdAt)`,
          ).run({
            ...workspace,
            repo: workspace.repo ?? null,
            branchPolicy: workspace.branchPolicy ?? null,
            permissionProfile: workspace.permissionProfile ?? null,
          });
          return workspace;
        });
        return tx.immediate();
      });
    },

    async createSession(input) {
      return writeQueue.enqueue(() => {
        // A run has one canonical Session. This is an idempotent get-or-create
        // under the same cross-process writer lock used by event seq allocation.
        const tx = db.transaction(() => {
          if (input.runId) {
            const existing = db
              .prepare(
                `select * from sessions
                 where run_id = ? and workspace_id = ?
                 order by created_at asc, rowid asc
                 limit 1`,
              )
              .get(input.runId, input.workspaceId) as SessionRow | undefined;
            if (existing) {
              return mapSession(existing);
            }
          }

          const createdAt = now();
          const session = sessionSchema.parse({
            id: `sess_${randomUUID()}`,
            workspaceId: input.workspaceId,
            title: input.title,
            profile: input.profile,
            status: 'active',
            createdAt,
            updatedAt: createdAt,
          });
          db.prepare(
            `insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
             values (@id, @workspaceId, @title, @profile, @status, @runId, @createdAt, @updatedAt)`,
          ).run({
            ...session,
            title: session.title ?? null,
            runId: input.runId ?? null,
          });
          return session;
        });
        return tx.immediate();
      });
    },

    async getSession(sessionId) {
      const row = db
        .prepare('select * from sessions where id = ?')
        .get(sessionId) as SessionRow | undefined;
      return row ? mapSession(row) : null;
    },

    async findSessionByRunId(runId) {
      const row = db
        .prepare(
          `select * from sessions
           where run_id = ?
           order by created_at asc, rowid asc
           limit 1`,
        )
        .get(runId) as SessionRow | undefined;
      return row ? mapSession(row) : null;
    },

    async listSessions(workspaceId) {
      const rows = db
        .prepare(
          `select s.*, coalesce(max(e.timestamp), s.created_at) as last_activity_at
           from sessions s
           left join session_events e on e.session_id = s.id
           where s.workspace_id = ?
           group by s.id
           order by last_activity_at desc, s.rowid desc`,
        )
        .all(workspaceId) as SessionListRow[];
      return rows.map((row) => ({
        ...mapSession(row),
        runId: row.run_id,
        lastActivityAt: row.last_activity_at,
      }));
    },

    async getRunIdBySessionId(sessionId) {
      const row = db
        .prepare('select run_id from sessions where id = ?')
        .get(sessionId) as { run_id: string | null } | undefined;
      return row?.run_id ?? null;
    },

    async updateSessionStatus(sessionId, status) {
      return writeQueue.enqueue(() => {
        db.prepare(
          'update sessions set status = ?, updated_at = ? where id = ?',
        ).run(status, now(), sessionId);
      });
    },

    async appendEvent(input) {
      return writeQueue.enqueue(() => {
        // The process-local WriteQueue cannot serialize writes from a separate
        // CLI/Web process. BEGIN IMMEDIATE acquires the database writer lock
        // before max(seq) is read, making allocation + insert one cross-process
        // critical section. busy_timeout handles short-lived contention.
        const append = db.transaction(() => {
          const maxRow = db
            .prepare(
              'select coalesce(max(seq), 0) as max_seq from session_events where session_id = ?',
            )
            .get(input.sessionId) as { max_seq: number };
          const event = sessionEventSchema.parse({
            sessionId: input.sessionId,
            seq: maxRow.max_seq + 1,
            type: input.type,
            version: SESSION_EVENT_SCHEMA_VERSION,
            timestamp: now(),
            payload: input.payload ?? {},
            visibility: input.visibility ?? 'ui-only',
            modelVisible: input.modelVisible ?? false,
            sourceEventSeqs: input.sourceEventSeqs ?? [],
            correlationId: input.correlationId ?? null,
          });
          db.prepare(
            `insert into session_events (
               session_id, seq, type, version, timestamp, payload,
               visibility, model_visible, source_event_seqs, correlation_id
             ) values (
               @sessionId, @seq, @type, @version, @timestamp, @payload,
               @visibility, @modelVisible, @sourceEventSeqs, @correlationId
             )`,
          ).run({
            sessionId: event.sessionId,
            seq: event.seq,
            type: event.type,
            version: event.version,
            timestamp: event.timestamp,
            payload: JSON.stringify(event.payload),
            visibility: event.visibility,
            modelVisible: event.modelVisible ? 1 : 0,
            sourceEventSeqs: JSON.stringify(event.sourceEventSeqs),
            correlationId: event.correlationId,
          });
          return event;
        });
        return append.immediate();
      });
    },

    async listEventsSince(sessionId, sinceSeq) {
      const rows = db
        .prepare(
          `select * from session_events
           where session_id = ? and seq > ?
           order by seq asc`,
        )
        .all(sessionId, sinceSeq) as SessionEventRow[];
      return rows.map(mapSessionEvent);
    },

    async latestSeq(sessionId) {
      const row = db
        .prepare(
          'select coalesce(max(seq), 0) as max_seq from session_events where session_id = ?',
        )
        .get(sessionId) as { max_seq: number };
      return row.max_seq;
    },

    async upsertProjectionCheckpoint(sessionId, name, lastSeq) {
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into projection_checkpoints (session_id, projection_name, last_seq, updated_at)
           values (@sessionId, @name, @lastSeq, @updatedAt)
           on conflict(session_id, projection_name) do update set
             last_seq = excluded.last_seq,
             updated_at = excluded.updated_at`,
        ).run({ sessionId, name, lastSeq, updatedAt: now() });
      });
    },
  };
}

export function createJobRepository(
  db: TekonDatabase,
  writeQueue: WriteQueue,
): JobRepository {
  const now = () => new Date().toISOString();

  return {
    async enqueue(job) {
      const parsed = jobSchema.parse(job);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into jobs (
             id, session_id, kind, status, owner, lease, abort_state,
             checkpoint, payload, created_at, updated_at
           ) values (
             @id, @sessionId, @kind, @status, @owner, @lease, @abortState,
             @checkpoint, @payload, @createdAt, @updatedAt
           )`,
        ).run({
          ...parsed,
          owner: parsed.owner ?? null,
          lease: parsed.lease ?? null,
          checkpoint: parsed.checkpoint ?? null,
          payload: JSON.stringify(job.payload ?? {}),
        });
        return parsed;
      });
    },

    async enqueueIfNoActiveByRunId(runId, job) {
      const parsed = jobSchema.parse(job);
      if (!RUN_EXECUTION_JOB_KINDS.has(parsed.kind)) {
        throw new Error(
          `enqueueIfNoActiveByRunId only accepts run-execution jobs, got: ${parsed.kind}`,
        );
      }
      const payload = JSON.stringify(job.payload ?? {});
      return writeQueue.enqueue(() => {
        // BEGIN IMMEDIATE acquires the database writer lock BEFORE the
        // active-job check, so a concurrent resume on another connection cannot
        // slip its INSERT between our check and our INSERT. Automation jobs are
        // deliberately excluded: readiness/delivery projection work must not
        // block or receive pause/cancel controls intended for the live workflow.
        const tx = db.transaction(() => {
          const binding = db
            .prepare('select run_id from sessions where id = ?')
            .get(parsed.sessionId) as { run_id: string | null } | undefined;
          if (!binding) {
            throw new Error(`session not found: ${parsed.sessionId}`);
          }
          if (binding.run_id !== runId) {
            throw new Error(
              `session ${parsed.sessionId} is bound to ${binding.run_id ?? 'no run'}, not ${runId}`,
            );
          }

          const existing = db
            .prepare(
              `select j.* from jobs j
               join sessions s on s.id = j.session_id
               where s.run_id = @runId
                 and j.kind in ('workflow-run', 'workflow-resume', 'goal-run')
                 and j.status in ('queued', 'running', 'paused', 'cancelling')
               order by j.created_at desc, j.id desc
               limit 1`,
            )
            .get({ runId }) as JobRow | undefined;
          if (existing) {
            return { outcome: 'active-job' as const, job: mapJob(existing) };
          }
          db.prepare(
            `insert into jobs (
               id, session_id, kind, status, owner, lease, abort_state,
               checkpoint, payload, created_at, updated_at
             ) values (
               @id, @sessionId, @kind, @status, @owner, @lease, @abortState,
               @checkpoint, @payload, @createdAt, @updatedAt
             )`,
          ).run({
            ...parsed,
            owner: parsed.owner ?? null,
            lease: parsed.lease ?? null,
            checkpoint: parsed.checkpoint ?? null,
            payload,
          });
          return { outcome: 'enqueued' as const, job: parsed };
        });
        return tx.immediate();
      });
    },

    async get(jobId) {
      const row = db.prepare('select * from jobs where id = ?').get(jobId) as
        | JobRow
        | undefined;
      return row ? mapJob(row) : null;
    },

    async findActiveByRunId(runId) {
      const row = db
        .prepare(
          `select j.* from jobs j
           join sessions s on s.id = j.session_id
           where s.run_id = ?
             and j.kind in ('workflow-run', 'workflow-resume', 'goal-run')
             and j.status in ('queued', 'running', 'paused', 'cancelling')
           order by j.created_at desc, j.id desc
           limit 1`,
        )
        .get(runId) as JobRow | undefined;
      return row ? mapJob(row) : null;
    },

    async cancelStaleActiveJobs(runId, exceptJobId, leaseCutoffIso) {
      return writeQueue.enqueue(() => {
        const cutoff =
          leaseCutoffIso ??
          new Date(Date.now() - DEFAULT_STALE_PAUSED_LEASE_MS).toISOString();
        // Only reclaim OLD jobs (design §2.2): a queued job younger than the
        // cutoff is very likely a concurrent enqueue in flight (the runner
        // polls every ~200ms; the lease TTL cutoff is 30s), NOT an abandoned
        // one. Without the created_at guard, two concurrent approves/resumes
        // race: the loser's reclaim cancels the winner's just-enqueued job,
        // leaving the run stuck at paused with a dead job (the winner already
        // returned 200). The age guard keeps the fresh job alive so the loser
        // instead 409s on findActiveByRunId (A1).
        const result = db
          .prepare(
            `update jobs
             set status = 'cancelled', abort_state = 'stopped', updated_at = @now
             where session_id in (select id from sessions where run_id = @runId)
               and kind in ('workflow-run', 'workflow-resume', 'goal-run')
               and (
                 (status = 'queued' and created_at < @cutoff)
                 or (status = 'paused' and lease is not null and lease < @cutoff)
               )
               and (@exceptJobId is null or id != @exceptJobId)`,
          )
          .run({ now: now(), runId, cutoff, exceptJobId: exceptJobId ?? null });
        return result.changes;
      });
    },

    async claimNext(owner) {
      return writeQueue.enqueue(() => {
        const claimedAt = now();
        // 选出最旧 queued job 的 id,再按该 id 条件写。better-sqlite3 同步执行,
        // 整个 enqueue 任务串行,select→update 之间无并发写者。以 id 回读被本次
        // 认领的确切行——不能用 "owner + updated_at desc" 回读:同 worker 认领多个
        // job 后 owner/status 相同,毫秒级 updated_at 可能相等 → 回读非确定(会
        // 错回上一个 job)。
        const target = db
          .prepare(
            `select id from jobs
             where status = 'queued'
             order by created_at asc, id asc
             limit 1`,
          )
          .get() as { id: string } | undefined;
        if (!target) {
          return null;
        }
        const result = db
          .prepare(
            `update jobs
             set status = 'running', owner = @owner, lease = @now, updated_at = @now
             where id = @id and status = 'queued'`,
          )
          .run({ owner, now: claimedAt, id: target.id });
        if (result.changes !== 1) {
          return null;
        }
        const row = db
          .prepare(`select * from jobs where id = @id`)
          .get({ id: target.id }) as JobRow | undefined;
        return row ? mapJob(row) : null;
      });
    },

    async updateJob(jobId, patch, condition) {
      return writeQueue.enqueue(() => {
        const sets: string[] = [];
        const where = ['id = @jobId'];
        const params: Record<string, unknown> = { jobId };
        let conditional = false;

        if (patch.status !== undefined) {
          sets.push('status = @status');
          params.status = patch.status;
        }
        if (patch.owner !== undefined) {
          sets.push('owner = @owner');
          params.owner = patch.owner;
        }
        if (patch.lease !== undefined) {
          sets.push('lease = @lease');
          params.lease = patch.lease;
        }
        if (patch.abortState !== undefined) {
          sets.push('abort_state = @abortState');
          params.abortState = patch.abortState;
        }
        if (patch.checkpoint !== undefined) {
          sets.push('checkpoint = @checkpoint');
          params.checkpoint = patch.checkpoint;
        }

        if (condition?.owner !== undefined) {
          conditional = true;
          if (condition.owner === null) {
            where.push('owner is null');
          } else {
            where.push('owner = @expectedOwner');
            params.expectedOwner = condition.owner;
          }
        }
        if (condition?.statuses !== undefined) {
          conditional = true;
          if (condition.statuses.length === 0) {
            where.push('0');
          } else {
            const placeholders = condition.statuses.map((status, index) => {
              const key = `expectedStatus${index}`;
              params[key] = status;
              return `@${key}`;
            });
            where.push(`status in (${placeholders.join(', ')})`);
          }
        }

        if (sets.length > 0) {
          sets.push('updated_at = @now');
          params.now = now();
          const result = db
            .prepare(
              `update jobs set ${sets.join(', ')} where ${where.join(' and ')}`,
            )
            .run(params);
          if (conditional && result.changes !== 1) {
            return null;
          }
        }

        const row = db.prepare('select * from jobs where id = ?').get(jobId) as
          | JobRow
          | undefined;
        return row ? mapJob(row) : null;
      });
    },

    async settleOwnedJob(jobId, owner, desiredStatus) {
      return writeQueue.enqueue(() => {
        // The owner check, cancellation precedence, and terminal update must be
        // one SQL statement. A read-then-write sequence lets a stale executor
        // settle a row after another process has reclaimed it.
        const result = db
          .prepare(
            `update jobs
             set status = case
                   when status = 'cancelling'
                     or abort_state in ('requested', 'propagated')
                   then 'cancelled'
                   else @desiredStatus
                 end,
                 abort_state = 'stopped',
                 updated_at = @now
             where id = @jobId
               and owner = @owner
               and status in ('running', 'paused', 'cancelling')`,
          )
          .run({ jobId, owner, desiredStatus, now: now() });
        if (result.changes !== 1) {
          return null;
        }
        const row = db.prepare('select * from jobs where id = ?').get(jobId) as
          | JobRow
          | undefined;
        return row ? mapJob(row) : null;
      });
    },

    async requeueStale(leaseOlderThanIso) {
      return writeQueue.enqueue(() => {
        const staleRows = db
          .prepare(
            `select abort_state from jobs
             where status in ('running', 'cancelling', 'paused')
               and lease < ?`,
          )
          .all(leaseOlderThanIso) as Array<{ abort_state: string }>;
        const cancelled = staleRows.filter((row) =>
          ['requested', 'propagated'].includes(row.abort_state),
        ).length;
        const result = db
          .prepare(
            `update jobs
             set status = case
                   when abort_state in ('requested', 'propagated') then 'cancelled'
                   else 'queued'
                 end,
                 abort_state = case
                   when abort_state in ('requested', 'propagated') then 'stopped'
                   else abort_state
                 end,
                 owner = null, lease = null, updated_at = @now
             where status in ('running', 'cancelling', 'paused')
               and lease < @cutoff`,
          )
          .run({ now: now(), cutoff: leaseOlderThanIso });
        return { requeued: result.changes - cancelled, cancelled };
      });
    },
  };
}

function mapWorkspace(row: WorkspaceRow): Workspace {
  return workspaceSchema.parse({
    id: row.id,
    root: row.root,
    repo: row.repo,
    branchPolicy: row.branch_policy,
    permissionProfile: row.permission_profile,
    createdAt: row.created_at,
  });
}

function mapSession(row: SessionRow): Session {
  return sessionSchema.parse({
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    profile: row.profile,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function mapSessionEvent(row: SessionEventRow): SessionEvent {
  return sessionEventSchema.parse({
    sessionId: row.session_id,
    seq: row.seq,
    type: row.type,
    version: row.version,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    visibility: row.visibility,
    modelVisible: row.model_visible === 1,
    sourceEventSeqs: JSON.parse(row.source_event_seqs) as number[],
    correlationId: row.correlation_id,
  });
}

function mapJob(row: JobRow): Job {
  // jobSchema intentionally has no `payload` key — zod strips the
  // contract-extra jobs.payload column on every read (S14).
  return jobSchema.parse({
    id: row.id,
    sessionId: row.session_id,
    kind: row.kind,
    status: row.status,
    owner: row.owner,
    lease: row.lease,
    abortState: row.abort_state,
    checkpoint: row.checkpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
