import { randomUUID } from 'node:crypto';
import { handOffInterruptedExecutionTxn, hasExitEvidence, latestExecutionJob, readRunRecovery, reconcileCancelledRunTxn, type RunRecovery } from './run-recovery.js';
import type { JobEnqueueResult, JobExitEvidence, ResumeConfirmation } from '../types/session-contract.js';

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
  /**
   * P1-UX-02: human-attention state. NULL until a human acknowledges/archives
   * the session; a failed session stays pinned (needsAction) while this is null.
   */
  acknowledgedAt: string | null;
};

export interface SessionEventStore {
  getRunRecovery(runId: string): Promise<RunRecovery>;
  reconcileCancelledRun(runId: string): Promise<{ sessionId?: string; events: SessionEvent[] }>;
  listCancelledRunIds(afterId: string, limit: number): Promise<string[]>;
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
   * job's sessionId to its workflow identity; subprocess scopes use Job IDs.
   */
  getRunIdBySessionId(sessionId: string): Promise<string | null>;
  updateSessionStatus(sessionId: string, status: SessionStatus): Promise<void>;
  /**
   * P1-UX-02: mark a session as acknowledged/archived by a human. Sets
   * acknowledged_at to now() (idempotent overwrite). Unknown session ids are a
   * no-op. The Session List uses this to drop a handled failure out of the
   * needs-action band. Returns the timestamp written, or null when no row matched.
   */
  acknowledgeSession(sessionId: string): Promise<string | null>;
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
  /**
   * Bounded page read for the long-session tail window (review P1-UX-03):
   * returns at most `limit` events with seq > sinceSeq in ascending order,
   * plus hasMore when further rows exist. listEventsSince stays unbounded
   * for internal contiguous catch-up; callers that need a bounded window
   * must use this method.
   */
  listEventsPage(
    sessionId: string,
    sinceSeq: number,
    limit: number,
  ): Promise<{ events: SessionEvent[]; hasMore: boolean }>;
  /**
   * Backward cursor page read for "load earlier history" (ninth-review
   * annotation 16.3): returns at most `limit` RAW events with seq < beforeSeq
   * in DESCENDING order, plus hasMore when older rows exist. The caller filters
   * visible events and derives the next cursor. Descending order is what lets
   * the server return a continuation cursor even when a whole raw page is
   * filtered out, fixing the old fixed-scan "empty visible page + hasMore but
   * no cursor" dead end.
   */
  listEventsBefore(
    sessionId: string,
    beforeSeq: number,
    limit: number,
  ): Promise<{ events: SessionEvent[]; hasMore: boolean }>;
  latestSeq(sessionId: string): Promise<number>;
  /**
   * Lightweight tail read for session.get's lastActivityAt: returns only the
   * tail event's timestamp (max seq, sharing listSessions' seq-desc tail
   * semantics) without deserializing the full event payload. Null when no
   * matching event rows exist for the given sessionId. (session_events has no
   * FK on session_id — see P1-DATA-01 — so "no events" is the real contract,
   * not "session does not exist".)
   */
  getLatestEventTimestamp(sessionId: string): Promise<string | null>;
  upsertProjectionCheckpoint(
    sessionId: string,
    name: string,
    lastSeq: number,
  ): Promise<void>;
}

export interface JobRepository {
  withOwnedWrite<T>(jobId: string, owner: string, operation: () => T | Promise<T>): T | Promise<T>;
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
    confirmation?: ResumeConfirmation,
  ): Promise<JobEnqueueResult>;
  /** Compatibility no-op: lease age never authorizes cancellation or requeue. */
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
      Pick<Job, 'status' | 'owner' | 'lease' | 'abortState' | 'checkpoint' | 'exitEvidence'>
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
    exitEvidence?: JobExitEvidence | null,
  ): Promise<Job | null>;
  interruptOwnedJob(jobId: string, owner: string): Promise<void>;
  interruptStale(leaseOlderThanIso: string, afterId: string, limit: number): Promise<{ processed: number; lastId: string | null; events: SessionEvent[] }>;
  requeueStale(
    leaseOlderThanIso: string,
  ): Promise<{ requeued: number; cancelled: number }>;
}

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
  acknowledged_at: string | null;
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
  exit_evidence: string | null;
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
    async getRunRecovery(runId) { return readRunRecovery(db, runId); },
    async reconcileCancelledRun(runId) {
      return writeQueue.enqueue(() => db.transaction(() => reconcileCancelledRunTxn(db, runId)).immediate());
    },
    async listCancelledRunIds(afterId, limit) {
      return (db.prepare(`select id from workflow_instances where status='cancelled' and id>?
        order by id limit ?`).all(afterId, Math.max(1, Math.min(100, limit))) as Array<{ id: string }>).map(row => row.id);
    },
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
      // P1-PERF-01: 使用相关子查询按 seq desc limit 1 取尾事件的 timestamp，
      // 避免全量 left join session_events + group by 的 O(全事件) 聚合代价。
      // 正确性依据：appendEvent 在同一 BEGIN IMMEDIATE 事务内 seq=max(seq)+1 与
      // timestamp=now() 同序分配，故 max(seq) 的事件恒为最新 timestamp；
      // 毫秒 tie 时 seq-desc 比 max(timestamp) 更精确。语义与旧查询一致（无事件回退 created_at）。
      // 依赖墙钟单调：若发生 NTP step-back，高 seq 事件可能拿到更早的墙钟标签，此时
      // seq-desc 取的是因果/追加序上最近发生的事件，比 max(timestamp) 更贴近"最近活动"。
      const rows = db
        .prepare(
          `select s.*,
             coalesce(
               (select e.timestamp from session_events e
                where e.session_id = s.id
                order by e.seq desc limit 1),
               s.created_at
             ) as last_activity_at
           from sessions s
           where s.workspace_id = ?
           order by last_activity_at desc, s.rowid desc`,
        )
        .all(workspaceId) as SessionListRow[];
      return rows.map((row) => ({
        ...mapSession(row),
        runId: row.run_id,
        lastActivityAt: row.last_activity_at,
        acknowledgedAt: row.acknowledged_at ?? null,
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

    async acknowledgeSession(sessionId) {
      return writeQueue.enqueue(() => {
        const acknowledgedAt = now();
        const info = db
          .prepare(
            'update sessions set acknowledged_at = ?, updated_at = ? where id = ?',
          )
          .run(acknowledgedAt, acknowledgedAt, sessionId);
        return info.changes > 0 ? acknowledgedAt : null;
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

    async listEventsPage(sessionId, sinceSeq, limit) {
      const rows = db
        .prepare(
          `select * from session_events
           where session_id = ? and seq > ?
           order by seq asc
           limit ?`,
        )
        .all(sessionId, sinceSeq, limit + 1) as SessionEventRow[];
      const hasMore = rows.length > limit;
      return {
        events: rows.slice(0, limit).map(mapSessionEvent),
        hasMore,
      };
    },

    async listEventsBefore(sessionId, beforeSeq, limit) {
      const rows = db
        .prepare(
          `select * from session_events
           where session_id = ? and seq < ?
           order by seq desc
           limit ?`,
        )
        .all(sessionId, beforeSeq, limit + 1) as SessionEventRow[];
      const hasMore = rows.length > limit;
      return {
        events: rows.slice(0, limit).map(mapSessionEvent),
        hasMore,
      };
    },

    async latestSeq(sessionId) {
      const row = db
        .prepare(
          'select coalesce(max(seq), 0) as max_seq from session_events where session_id = ?',
        )
        .get(sessionId) as { max_seq: number };
      return row.max_seq;
    },

    async getLatestEventTimestamp(sessionId) {
      // Tail read via the (session_id, seq) index: reverse-scan to the last
      // row and project only timestamp, avoiding payload deserialization.
      // Same seq-desc tail semantics as listSessions' correlated subquery.
      const row = db
        .prepare(
          `select timestamp from session_events
           where session_id = ?
           order by seq desc
           limit 1`,
        )
        .get(sessionId) as { timestamp: string } | undefined;
      return row?.timestamp ?? null;
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
    withOwnedWrite(jobId, owner, operation) {
      return db.transaction(() => {
        const current = db.prepare('select owner,status from jobs where id=?').get(jobId) as { owner: string | null; status: string } | undefined;
        if (!current || current.owner !== owner || !['running','paused','cancelling'].includes(current.status)) {
          throw new Error(`JOB_FENCING: execution ${jobId} no longer owns writes`);
        }
        return operation();
      }).immediate();
    },
    async enqueue(job) {
      const parsed = jobSchema.parse(job);
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into jobs (
             id, session_id, kind, status, owner, lease, abort_state,
             checkpoint, payload, created_at, updated_at, exit_evidence
           ) values (
             @id, @sessionId, @kind, @status, @owner, @lease, @abortState,
             @checkpoint, @payload, @createdAt, @updatedAt, @exitEvidence
           )`,
        ).run({
          ...parsed,
          owner: parsed.owner ?? null,
          lease: parsed.lease ?? null,
          checkpoint: parsed.checkpoint ?? null,
          payload: JSON.stringify(job.payload ?? {}),
          exitEvidence: parsed.exitEvidence ? JSON.stringify(parsed.exitEvidence) : null,
        });
        return parsed;
      });
    },

    async enqueueIfNoActiveByRunId(runId, job, confirmation = {}) {
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

          const run = db.prepare('select status from workflow_instances where id=?').get(runId) as { status: string } | undefined;
          if (run && ['passed','failed','cancelled'].includes(run.status)) {
            return { outcome: 'terminal' as const, status: run.status as 'passed'|'failed'|'cancelled' };
          }
          const latest = latestExecutionJob(db, runId);
          const previousJobId = latest?.id ?? null;
          if (confirmation.previousJobId !== undefined && confirmation.previousJobId !== previousJobId) {
            return { outcome: 'stale-confirmation' as const, previousJobId };
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
          const needsConfirmation = latest ? !hasExitEvidence(latest.exit_evidence) : run?.status === 'interrupted';
          if (needsConfirmation && (!confirmation.confirmStopped || confirmation.previousJobId === undefined)) {
            return { outcome: 'exit-unconfirmed' as const, previousJobId };
          }
          // Monotonic generation ordering even when admissions share a millisecond.
          if (latest && parsed.createdAt <= latest.created_at) {
            parsed.createdAt = new Date(Date.parse(latest.created_at) + 1).toISOString();
            parsed.updatedAt = parsed.createdAt;
          }
          if (run) handOffInterruptedExecutionTxn(db, runId, confirmation, previousJobId, parsed.id);
          db.prepare(
            `insert into jobs (
               id, session_id, kind, status, owner, lease, abort_state,
               checkpoint, payload, created_at, updated_at, exit_evidence
             ) values (
               @id, @sessionId, @kind, @status, @owner, @lease, @abortState,
               @checkpoint, @payload, @createdAt, @updatedAt, @exitEvidence
             )`,
          ).run({
            ...parsed,
            owner: parsed.owner ?? null,
            lease: parsed.lease ?? null,
            checkpoint: parsed.checkpoint ?? null,
            payload,
            exitEvidence: parsed.exitEvidence ? JSON.stringify(parsed.exitEvidence) : null,
          });
          return { outcome: 'enqueued' as const, job: parsed, ...(confirmation.confirmStopped ? { previousJobId } : {}) };
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

    async cancelStaleActiveJobs() {
      // Legacy callers cannot turn a stale lease into proof of exit. Recovery is
      // performed by interruptStale and the guarded explicit resume transaction.
      return 0;
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
            `select j.id from jobs j
             left join sessions s on s.id = j.session_id
             left join run_admissions a on a.run_id = s.run_id
             left join workflow_instances w on w.id = s.run_id
             where j.status = 'queued'
               and (a.files_state is null or a.files_state = 'ready')
               and (j.kind not in ('workflow-run','workflow-resume','goal-run') or w.status is null or w.status not in ('passed','failed','cancelled'))
             order by j.created_at asc, j.id asc
             limit 1`,
          )
          .get() as { id: string } | undefined;
        if (!target) {
          return null;
        }
        const result = db
          .prepare(
            `update jobs
             set status = 'running', owner = @owner, lease = @now, updated_at = @now, exit_evidence = null
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
        if (patch.exitEvidence !== undefined) {
          sets.push('exit_evidence = @exitEvidence');
          params.exitEvidence = patch.exitEvidence ? JSON.stringify(patch.exitEvidence) : null;
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

    async settleOwnedJob(jobId, owner, desiredStatus, exitEvidence = null) {
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
                 abort_state = case when @exitEvidence is not null then 'stopped' else abort_state end,
                 exit_evidence = @exitEvidence,
                 updated_at = @now
             where id = @jobId
               and owner = @owner
               and status in ('running', 'paused', 'cancelling')`,
          )
          .run({ jobId, owner, desiredStatus, exitEvidence: exitEvidence ? JSON.stringify(exitEvidence) : null, now: now() });
        if (result.changes !== 1) {
          return null;
        }
        const row = db.prepare('select * from jobs where id = ?').get(jobId) as
          | JobRow
          | undefined;
        return row ? mapJob(row) : null;
      });
    },

    async interruptOwnedJob(jobId, owner) {
      await writeQueue.enqueue(() => db.transaction(() => {
        const row = db.prepare(`select j.*,s.run_id from jobs j left join sessions s on s.id=j.session_id
          where j.id=? and j.owner=? and j.status in ('running','paused','cancelling')`).get(jobId,owner) as (JobRow & { run_id: string | null }) | undefined;
        if (row) interruptJobTxn(db,row,null);
      }).immediate());
    },

    async interruptStale(leaseOlderThanIso, afterId, limit) {
      return writeQueue.enqueue(() => db.transaction(() => {
        const rows = db.prepare(`select j.*,s.run_id from jobs j left join sessions s on s.id=j.session_id
          where j.id>? and j.status in ('running','cancelling','paused') and j.lease<?
          order by j.id limit ?`).all(afterId,leaseOlderThanIso,Math.max(1,Math.min(100,limit))) as Array<JobRow & { run_id: string | null }>;
        let processed = 0;
        const events: SessionEvent[] = [];
        for (const row of rows) {
          try {
            // A failing row rolls back only itself, and its cursor still advances.
            const committed = db.transaction(() => {
              const rowEvents: SessionEvent[] = [];
              const count = interruptJobTxn(db, row, leaseOlderThanIso, rowEvents);
              return { count, rowEvents };
            }).immediate();
            processed += committed.count;
            events.push(...committed.rowEvents);
          } catch { /* next page progresses; retry after wrap */ }
        }
        return { processed, lastId: rows.at(-1)?.id ?? null, events };
      }).immediate());
    },

    async requeueStale(leaseOlderThanIso) {
      // Compatibility entry point; never automatically re-executes stale work.
      const result = await this.interruptStale(leaseOlderThanIso, '', 100);
      return { requeued: 0, cancelled: result.processed };
    },
  };
}

/** The caller holds the writer lock. Never turns an expired lease into exit proof. */
function interruptJobTxn(db: TekonDatabase, row: JobRow & { run_id: string | null }, cutoff: string | null, events?: SessionEvent[]): number {
  const now = new Date().toISOString();
  const run = row.run_id ? db.prepare('select status from workflow_instances where id=?').get(row.run_id) as { status: string } | undefined : undefined;
  const execution = RUN_EXECUTION_JOB_KINDS.has(row.kind);
  const cancelled = row.status === 'cancelling' || ['requested','propagated'].includes(row.abort_state) || (execution && run?.status === 'cancelled');
  const changed = db.prepare(`update jobs set status=?,owner=null,lease=null,exit_evidence=null,updated_at=?
    where id=? and owner is ? and status=? and (? is null or lease<?)`)
    .run(cancelled ? 'cancelled':'interrupted',now,row.id,row.owner,row.status,cutoff,cutoff);
  if (!changed.changes) return 0;
  if (execution && row.run_id && latestExecutionJob(db,row.run_id)?.id === row.id) {
    db.prepare("update workflow_instances set status='interrupted',updated_at=? where id=? and status not in ('passed','failed','cancelled')").run(now,row.run_id);
    const authoritative = db.prepare('select status from workflow_instances where id=?').get(row.run_id) as { status: string } | undefined;
    if (authoritative?.status === 'interrupted') db.prepare("update sessions set status='awaiting-input',updated_at=? where id=?").run(now,row.session_id);
  }
  // Persist the notification with the state change. SSE catch-up still sees it
  // if the owner exits before the runner can publish the committed event.
  const { seq } = db.prepare('select coalesce(max(seq),0)+1 as seq from session_events where session_id=?')
    .get(row.session_id) as { seq: number };
  const event = sessionEventSchema.parse({ sessionId: row.session_id, seq, type: 'job/status', version: 1,
    timestamp: now, payload: { jobId: row.id, kind: row.kind, status: cancelled ? 'cancelled' : 'interrupted' } });
  db.prepare('insert into session_events(session_id,seq,type,version,timestamp,payload) values(?,?,?,?,?,?)')
    .run(row.session_id, seq, event.type, event.version, event.timestamp, JSON.stringify(event.payload));
  events?.push(event);
  return 1;
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
    exitEvidence: row.exit_evidence ? JSON.parse(row.exit_evidence) : null,
    checkpoint: row.checkpoint,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}
