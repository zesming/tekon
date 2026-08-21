import { randomUUID } from 'node:crypto';

import type { TekonDatabase } from '../db/connection.js';
import type { WriteQueue } from '../db/write-queue.js';
import {
  SESSION_EVENT_SCHEMA_VERSION,
  type EventVisibility,
  type Job,
  jobSchema,
  type Session,
  sessionSchema,
  type SessionEvent,
  sessionEventSchema,
  type SessionStatus,
  type Workspace,
  workspaceSchema,
} from '../types/session-contract.js';

/**
 * `jobs.payload` is a runner implementation detail and intentionally outside
 * the frozen `Job` contract (S14). It may be supplied at enqueue time for
 * debugging; every read path strips it via `jobSchema.parse`.
 */
export type JobEnqueueInput = Job & { payload?: Record<string, unknown> };

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
  updateJob(
    jobId: string,
    patch: Partial<
      Pick<Job, 'status' | 'owner' | 'lease' | 'abortState' | 'checkpoint'>
    >,
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
        const existing = db
          .prepare('select * from workspaces where root = ?')
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
    },

    async createSession(input) {
      const session = sessionSchema.parse({
        id: `sess_${randomUUID()}`,
        workspaceId: input.workspaceId,
        title: input.title,
        profile: input.profile,
        status: 'active',
        createdAt: now(),
        updatedAt: now(),
      });
      return writeQueue.enqueue(() => {
        db.prepare(
          `insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
           values (@id, @workspaceId, @title, @profile, @status, @runId, @createdAt, @updatedAt)`,
        ).run({ ...session, title: session.title ?? null, runId: input.runId ?? null });
        return session;
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
        .prepare('select * from sessions where run_id = ? order by created_at desc limit 1')
        .get(runId) as SessionRow | undefined;
      return row ? mapSession(row) : null;
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

    async get(jobId) {
      const row = db
        .prepare('select * from jobs where id = ?')
        .get(jobId) as JobRow | undefined;
      return row ? mapJob(row) : null;
    },

    async findActiveByRunId(runId) {
      const row = db
        .prepare(
          `select j.* from jobs j
           join sessions s on s.id = j.session_id
           where s.run_id = ?
             and j.status in ('queued', 'running', 'paused', 'cancelling')
           order by j.created_at desc
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

    async updateJob(jobId, patch) {
      return writeQueue.enqueue(() => {
        const sets: string[] = [];
        const params: Record<string, unknown> = { jobId };
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
        if (sets.length > 0) {
          sets.push('updated_at = @now');
          params.now = now();
          db.prepare(
            `update jobs set ${sets.join(', ')} where id = @jobId`,
          ).run(params);
        }
        const row = db
          .prepare('select * from jobs where id = ?')
          .get(jobId) as JobRow | undefined;
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
