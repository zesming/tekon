import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createJobRepository,
  createSessionEventStore,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  type JobEnqueueInput,
  type JobRepository,
  type Session,
  type SessionEventStore,
  type Workspace,
} from '../../src/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function setupStore() {
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  const sessions = createSessionEventStore(db, writeQueue);
  const jobs = createJobRepository(db, writeQueue);
  return { db, writeQueue, sessions, jobs };
}

async function seedSession(
  sessions: SessionEventStore,
  root = '/tmp/tekon',
  runId = 'run_1',
): Promise<{ workspace: Workspace; session: Session }> {
  const workspace = await sessions.getOrCreateDefaultWorkspace(root);
  const session = await sessions.createSession({
    workspaceId: workspace.id,
    title: 'test session',
    profile: 'human-web',
    runId,
  });
  return { workspace, session };
}

function makeJob(
  sessionId: string,
  overrides: Partial<JobEnqueueInput> = {},
): JobEnqueueInput {
  const now = '2026-08-21T00:00:00.000Z';
  return {
    id: `job_${randomUUID()}`,
    sessionId,
    kind: 'workflow-run',
    status: 'queued',
    owner: null,
    lease: null,
    abortState: 'none',
    checkpoint: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe('session event store', () => {
  it('assigns a monotonic seq per session and independent seqs across sessions', async () => {
    const { sessions } = setupStore();
    const { session: a } = await seedSession(sessions, '/repo/a');
    const { session: b } = await seedSession(sessions, '/repo/b');

    const e1 = await sessions.appendEvent({
      sessionId: a.id,
      type: 'turn/start',
    });
    const e2 = await sessions.appendEvent({
      sessionId: a.id,
      type: 'turn/end',
    });
    const e3 = await sessions.appendEvent({
      sessionId: b.id,
      type: 'turn/start',
    });
    const e4 = await sessions.appendEvent({
      sessionId: a.id,
      type: 'agent/status',
    });

    expect([e1.seq, e2.seq, e4.seq]).toEqual([1, 2, 3]);
    expect(e3.seq).toBe(1);
    expect(await sessions.latestSeq(a.id)).toBe(3);
    expect(await sessions.latestSeq(b.id)).toBe(1);
  });

  it('listEventsSince returns events with seq strictly greater than the cursor', async () => {
    const { sessions } = setupStore();
    const { session } = await seedSession(sessions);

    await sessions.appendEvent({ sessionId: session.id, type: 'turn/start' });
    await sessions.appendEvent({ sessionId: session.id, type: 'turn/end' });
    await sessions.appendEvent({ sessionId: session.id, type: 'agent/status' });

    const since = await sessions.listEventsSince(session.id, 1);
    expect(since.map((event) => event.seq)).toEqual([2, 3]);
    expect(await sessions.listEventsSince(session.id, 3)).toEqual([]);
  });

  it('roundtrips payloads, arrays, booleans, and event metadata', async () => {
    const { sessions } = setupStore();
    const { session } = await seedSession(sessions);

    const appended = await sessions.appendEvent({
      sessionId: session.id,
      type: 'agent/status',
      payload: {
        nested: { arr: [1, 2, { ok: true }], flag: false, text: 'hello' },
      },
      visibility: 'model',
      modelVisible: true,
      sourceEventSeqs: [1, 2],
      correlationId: 'corr_1',
    });

    expect(appended.version).toBe(1);
    const [read] = await sessions.listEventsSince(session.id, 0);
    expect(read).toEqual(appended);
    expect(read.payload).toEqual({
      nested: { arr: [1, 2, { ok: true }], flag: false, text: 'hello' },
    });
    expect(read.visibility).toBe('model');
    expect(read.modelVisible).toBe(true);
    expect(read.sourceEventSeqs).toEqual([1, 2]);
    expect(read.correlationId).toBe('corr_1');
  });

  it('creates, reads, and updates sessions', async () => {
    const { sessions } = setupStore();
    const { workspace, session } = await seedSession(sessions);

    expect(session).toMatchObject({
      workspaceId: workspace.id,
      title: 'test session',
      profile: 'human-web',
      status: 'active',
    });
    expect(await sessions.getSession(session.id)).toEqual(session);
    expect(await sessions.findSessionByRunId('run_1')).toEqual(session);

    await sessions.updateSessionStatus(session.id, 'done');
    expect(await sessions.getSession(session.id)).toMatchObject({
      status: 'done',
    });
    expect(await sessions.findSessionByRunId('run_missing')).toBeNull();
    expect(await sessions.getSession('session_missing')).toBeNull();
  });

  it('getOrCreateDefaultWorkspace is idempotent per root', async () => {
    const { sessions } = setupStore();

    const first = await sessions.getOrCreateDefaultWorkspace('/repo/a');
    const second = await sessions.getOrCreateDefaultWorkspace('/repo/a');
    expect(second).toEqual(first);

    const other = await sessions.getOrCreateDefaultWorkspace('/repo/b');
    expect(other.id).not.toBe(first.id);
    expect(other.root).toBe('/repo/b');
  });

  it('converges default workspace creation across independent connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-workspace-race-'));
    tempDirs.push(dir);
    const filename = join(dir, 'tekon.sqlite');
    const dbA = openTekonDatabase({ filename });
    const dbB = openTekonDatabase({ filename });
    try {
      migrateDatabase(dbA);
      migrateDatabase(dbB);
      const storeA = createSessionEventStore(dbA, createWriteQueue());
      const storeB = createSessionEventStore(dbB, createWriteQueue());

      const [a, b] = await Promise.all([
        storeA.getOrCreateDefaultWorkspace(dir),
        storeB.getOrCreateDefaultWorkspace(dir),
      ]);

      expect(a.id).toBe(b.id);
      const count = dbA
        .prepare('select count(*) as n from workspaces where root = ?')
        .get(dir) as { n: number };
      expect(count.n).toBe(1);
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it('converges one canonical run session across independent connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-session-race-'));
    tempDirs.push(dir);
    const filename = join(dir, 'tekon.sqlite');
    const dbA = openTekonDatabase({ filename });
    const dbB = openTekonDatabase({ filename });
    try {
      migrateDatabase(dbA);
      migrateDatabase(dbB);
      const storeA = createSessionEventStore(dbA, createWriteQueue());
      const storeB = createSessionEventStore(dbB, createWriteQueue());
      const workspace = await storeA.getOrCreateDefaultWorkspace(dir);

      const [a, b] = await Promise.all([
        storeA.createSession({
          workspaceId: workspace.id,
          title: 'first candidate',
          profile: 'human-web',
          runId: 'run_same',
        }),
        storeB.createSession({
          workspaceId: workspace.id,
          title: 'second candidate',
          profile: 'human-web',
          runId: 'run_same',
        }),
      ]);

      expect(a.id).toBe(b.id);
      const count = dbA
        .prepare('select count(*) as n from sessions where run_id = ?')
        .get('run_same') as { n: number };
      expect(count.n).toBe(1);
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it('upserts projection checkpoints', async () => {
    const { db, sessions } = setupStore();
    const { session } = await seedSession(sessions);

    await sessions.upsertProjectionCheckpoint(session.id, 'feed', 5);
    await sessions.upsertProjectionCheckpoint(session.id, 'feed', 9);
    await sessions.upsertProjectionCheckpoint(session.id, 'other', 1);

    const row = db
      .prepare(
        'select last_seq from projection_checkpoints where session_id = ? and projection_name = ?',
      )
      .get(session.id, 'feed') as { last_seq: number };
    expect(row.last_seq).toBe(9);
    const other = db
      .prepare(
        'select last_seq from projection_checkpoints where session_id = ? and projection_name = ?',
      )
      .get(session.id, 'other') as { last_seq: number };
    expect(other.last_seq).toBe(1);
  });
  it('allocates monotonic event seqs across independent database connections', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-session-seq-'));
    tempDirs.push(dir);
    const filename = join(dir, 'tekon.sqlite');
    const dbA = openTekonDatabase({ filename });
    const dbB = openTekonDatabase({ filename });
    try {
      migrateDatabase(dbA);
      migrateDatabase(dbB);
      const storeA = createSessionEventStore(dbA, createWriteQueue());
      const storeB = createSessionEventStore(dbB, createWriteQueue());
      const workspace = await storeA.getOrCreateDefaultWorkspace(dir);
      const session = await storeA.createSession({
        workspaceId: workspace.id,
        title: 'two connections',
        profile: 'human-web',
        runId: null,
      });

      const appended = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          (index % 2 === 0 ? storeA : storeB).appendEvent({
            sessionId: session.id,
            type: 'agent/status',
            payload: { index },
          }),
        ),
      );
      const seqs = appended.map((event) => event.seq).sort((a, b) => a - b);
      expect(seqs).toEqual(Array.from({ length: 40 }, (_, index) => index + 1));
      expect(
        (await storeA.listEventsSince(session.id, 0)).map((event) => event.seq),
      ).toEqual(seqs);
    } finally {
      dbA.close();
      dbB.close();
    }
  });
});

describe('job repository', () => {
  it('strips the contract-extra payload column from every job read (S14)', async () => {
    const { db, sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);

    const enqueued = await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_p',
        payload: { runId: 'run_1', secret: 's3cr3t' },
      }),
    );
    expect(enqueued).not.toHaveProperty('payload');

    // The payload column is persisted for debugging, but never re-exposed.
    const row = db
      .prepare('select payload from jobs where id = ?')
      .get('job_p') as { payload: string };
    expect(JSON.parse(row.payload)).toEqual({
      runId: 'run_1',
      secret: 's3cr3t',
    });

    const claimed = await jobs.claimNext('worker_1');
    expect(claimed?.id).toBe('job_p');
    expect(claimed).not.toHaveProperty('payload');

    await jobs.updateJob('job_p', {
      status: 'running',
      owner: 'worker_1',
      lease: '2026-08-21T00:01:00.000Z',
    });
    const got = await jobs.get('job_p');
    expect(got).not.toHaveProperty('payload');
    expect(got).toMatchObject({ status: 'running', owner: 'worker_1' });

    const rowAfterUpdate = db
      .prepare('select payload from jobs where id = ?')
      .get('job_p') as { payload: string };
    expect(rowAfterUpdate.payload).toBe(row.payload);

    const found = await jobs.findActiveByRunId('run_1');
    expect(found).not.toHaveProperty('payload');
    expect(found?.id).toBe('job_p');
  });

  it('claims the oldest queued job atomically and records owner and lease', async () => {
    const { sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);

    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_1',
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_2',
        createdAt: '2026-08-21T00:01:00.000Z',
        updatedAt: '2026-08-21T00:01:00.000Z',
      }),
    );

    const first = await jobs.claimNext('worker_1');
    expect(first).toMatchObject({
      id: 'job_1',
      status: 'running',
      owner: 'worker_1',
    });
    expect(first?.lease).toBeTruthy();

    const second = await jobs.claimNext('worker_1');
    expect(second?.id).toBe('job_2');

    expect(await jobs.claimNext('worker_1')).toBeNull();
  });

  it('requeues stale jobs by abort state and leaves live leases untouched (M4/M2)', async () => {
    const { sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);
    const stale = '2026-08-20T00:00:00.000Z';
    const fresh = '2026-08-21T12:00:00.000Z';

    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_running',
        status: 'running',
        owner: 'w1',
        lease: stale,
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_requested',
        status: 'cancelling',
        owner: 'w1',
        lease: stale,
        abortState: 'requested',
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_paused',
        status: 'paused',
        owner: 'w1',
        lease: stale,
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_paused_cancel',
        status: 'paused',
        owner: 'w1',
        lease: stale,
        abortState: 'propagated',
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_live',
        status: 'running',
        owner: 'w1',
        lease: fresh,
      }),
    );
    await jobs.enqueue(makeJob(session.id, { id: 'job_queued' }));

    const result = await jobs.requeueStale('2026-08-21T00:00:00.000Z');
    expect(result).toEqual({ requeued: 2, cancelled: 2 });

    expect(await jobs.get('job_running')).toMatchObject({
      status: 'queued',
      owner: null,
      lease: null,
      abortState: 'none',
    });
    expect(await jobs.get('job_paused')).toMatchObject({
      status: 'queued',
      owner: null,
      lease: null,
    });
    expect(await jobs.get('job_requested')).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
      owner: null,
      lease: null,
    });
    expect(await jobs.get('job_paused_cancel')).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
    expect(await jobs.get('job_live')).toMatchObject({
      status: 'running',
      owner: 'w1',
      lease: fresh,
    });
    expect(await jobs.get('job_queued')).toMatchObject({ status: 'queued' });
  });

  it('cancels only queued and stale-paused jobs for a run (S3)', async () => {
    const { sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);
    // Explicit cutoff keeps this deterministic: with the default (wall-clock)
    // cutoff, a hardcoded "fresh" lease is overtaken once real time passes it.
    // The default-cutoff path is covered by the A1 test below.
    const cutoff = '2026-08-21T06:00:00.000Z';
    const stale = '2026-08-20T00:00:00.000Z';
    const fresh = '2026-08-21T12:00:00.000Z';

    await jobs.enqueue(makeJob(session.id, { id: 'job_queued' }));
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_stale_paused',
        status: 'paused',
        owner: 'w1',
        lease: stale,
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_live_paused',
        status: 'paused',
        owner: 'w1',
        lease: fresh,
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_running',
        status: 'running',
        owner: 'w1',
        lease: fresh,
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_cancelling',
        status: 'cancelling',
        owner: 'w1',
        lease: fresh,
        abortState: 'requested',
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, { id: 'job_except', status: 'queued' }),
    );

    const count = await jobs.cancelStaleActiveJobs(
      'run_1',
      'job_except',
      cutoff,
    );
    expect(count).toBe(2);

    expect(await jobs.get('job_queued')).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
    expect(await jobs.get('job_stale_paused')).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
    expect(await jobs.get('job_live_paused')).toMatchObject({
      status: 'paused',
    });
    expect(await jobs.get('job_running')).toMatchObject({ status: 'running' });
    expect(await jobs.get('job_cancelling')).toMatchObject({
      status: 'cancelling',
    });
    expect(await jobs.get('job_except')).toMatchObject({ status: 'queued' });

    // A run without sessions/jobs is a no-op.
    expect(await jobs.cancelStaleActiveJobs('run_missing')).toBe(0);
  });

  it('A1: cancelStaleActiveJobs reclaims OLD queued jobs but spares fresh ones', async () => {
    const { sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);

    // An old queued job (created long ago) is abandoned → reclaimed. A freshly
    // enqueued queued job (created "now") is a concurrent enqueue in flight and
    // MUST survive, so a losing concurrent approve/resume cannot cancel the
    // winner's just-enqueued job (A1 regression).
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_old_queued',
        status: 'queued',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_fresh_queued',
        status: 'queued',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    const cancelled = await jobs.cancelStaleActiveJobs('run_1');
    expect(cancelled).toBe(1);
    expect(await jobs.get('job_old_queued')).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
    expect(await jobs.get('job_fresh_queued')).toMatchObject({
      status: 'queued',
    });
  });

  it('findActiveByRunId returns the newest active job for the run', async () => {
    const { sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);

    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_old',
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_new',
        createdAt: '2026-08-21T00:01:00.000Z',
        updatedAt: '2026-08-21T00:01:00.000Z',
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_done',
        status: 'done',
        createdAt: '2026-08-21T00:02:00.000Z',
        updatedAt: '2026-08-21T00:02:00.000Z',
      }),
    );

    const active = await jobs.findActiveByRunId('run_1');
    expect(active?.id).toBe('job_new');
    expect(active).not.toHaveProperty('payload');
    expect(await jobs.findActiveByRunId('run_missing')).toBeNull();
  });

  it('cancelStaleActiveJobs honors a custom lease cutoff (S4 parameterization)', async () => {
    const { sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);
    const staleLease = '2020-01-01T00:00:00.000Z';
    const freshLease = new Date().toISOString();

    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_paused_old',
        status: 'paused',
        owner: 'w1',
        lease: staleLease,
      }),
    );
    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_paused_new',
        status: 'paused',
        owner: 'w1',
        lease: freshLease,
      }),
    );

    // Custom cutoff (1s ago): only the 2020 lease is stale; the fresh one is not.
    const count = await jobs.cancelStaleActiveJobs(
      'run_1',
      undefined,
      new Date(Date.now() - 1000).toISOString(),
    );
    expect(count).toBe(1);
    expect(await jobs.get('job_paused_old')).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
    expect(await jobs.get('job_paused_new')).toMatchObject({
      status: 'paused',
    });

    // Without a custom cutoff the 30s default applies: the fresh paused lease
    // is not stale, so only the queued job is cancelled.
    await jobs.enqueue(
      makeJob(session.id, { id: 'job_queued', status: 'queued' }),
    );
    expect(await jobs.cancelStaleActiveJobs('run_1')).toBe(1);
    expect(await jobs.get('job_queued')).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
    expect(await jobs.get('job_paused_new')).toMatchObject({
      status: 'paused',
    });
  });

  it('keeps automation jobs outside run execution controls and resume exclusion', async () => {
    const { sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);

    await jobs.enqueue(
      makeJob(session.id, {
        id: 'job_readiness',
        kind: 'readiness-evaluate',
        status: 'queued',
        createdAt: '2020-01-01T00:00:00.000Z',
        updatedAt: '2020-01-01T00:00:00.000Z',
      }),
    );

    // A readiness projection is not the live workflow: it must not receive
    // run pause/cancel, block resume, or be reclaimed as a stale run job.
    expect(await jobs.findActiveByRunId('run_1')).toBeNull();
    expect(await jobs.cancelStaleActiveJobs('run_1')).toBe(0);
    expect(await jobs.get('job_readiness')).toMatchObject({ status: 'queued' });

    const resumed = await jobs.enqueueIfNoActiveByRunId(
      'run_1',
      makeJob(session.id, { id: 'job_resume', kind: 'workflow-resume' }),
    );
    expect(resumed.outcome).toBe('enqueued');
    expect(await jobs.findActiveByRunId('run_1')).toMatchObject({
      id: 'job_resume',
      kind: 'workflow-resume',
    });
  });

  it('rejects an atomic enqueue whose Session is missing or bound to another run', async () => {
    const { sessions, jobs } = setupStore();
    const { workspace } = await seedSession(sessions);
    const other = await sessions.createSession({
      workspaceId: workspace.id,
      title: 'other run',
      profile: 'human-web',
      runId: 'run_other',
    });

    await expect(
      jobs.enqueueIfNoActiveByRunId(
        'run_1',
        makeJob(other.id, { id: 'job_wrong_binding', kind: 'workflow-resume' }),
      ),
    ).rejects.toThrow(/bound to run_other/u);

    await expect(
      jobs.enqueueIfNoActiveByRunId(
        'run_1',
        makeJob('sess_missing', {
          id: 'job_missing_session',
          kind: 'workflow-resume',
        }),
      ),
    ).rejects.toThrow(/session not found/u);
  });

  it('rejects automation kinds at the run-execution-only atomic enqueue boundary', async () => {
    const { sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);

    await expect(
      jobs.enqueueIfNoActiveByRunId(
        'run_1',
        makeJob(session.id, {
          id: 'job_wrong_kind',
          kind: 'readiness-evaluate',
        }),
      ),
    ).rejects.toThrow(/only accepts run-execution jobs/u);
  });

  it('enqueueIfNoActiveByRunId enqueues when the run has no active job, and rejects when one exists', async () => {
    const { sessions, jobs } = setupStore();
    const { session } = await seedSession(sessions);

    // No active job → enqueued.
    const first = await jobs.enqueueIfNoActiveByRunId(
      'run_1',
      makeJob(session.id, { id: 'job_a', kind: 'workflow-resume' }),
    );
    expect(first.outcome).toBe('enqueued');
    expect(first.job.id).toBe('job_a');
    expect(await jobs.findActiveByRunId('run_1')).toMatchObject({
      id: 'job_a',
    });

    // An active job now exists → the second call is rejected and returns the
    // existing active job (NOT a second insert).
    const second = await jobs.enqueueIfNoActiveByRunId(
      'run_1',
      makeJob(session.id, { id: 'job_b', kind: 'workflow-resume' }),
    );
    expect(second.outcome).toBe('active-job');
    expect(second.job.id).toBe('job_a');
    expect(await jobs.get('job_b')).toBeNull();
  });

  it('F5-P0-01: enqueueIfNoActiveByRunId yields exactly one active job across two connections', async () => {
    // Cross-connection integration check for the atomic guard. `:memory:` is
    // per-connection, so a real two-process setup needs a FILE db opened by two
    // connections (as CLI + Web would). Note: better-sqlite3 is synchronous, so
    // a single-thread test cannot force a mid-transaction interleave — the
    // atomicity itself (check + insert under one BEGIN IMMEDIATE writer lock) is
    // guaranteed by the same pattern `appendEvent` uses for seq allocation. What
    // this test pins is that the method, driven from two independent connections
    // + WriteQueues, still converges to a single active job (the loser observes
    // the winner's job). The re-check logic is separately locked by the test
    // above (removing the in-transaction re-check makes that one fail).
    const dir = mkdtempSync(join(tmpdir(), 'tekon-f5p0-01-'));
    tempDirs.push(dir);
    const file = join(dir, 'tekon.sqlite');

    // Connection 1 sets up the schema + a run row + a session bound to the run.
    const db1 = openTekonDatabase({ filename: file });
    migrateDatabase(db1);
    const now = new Date().toISOString();
    db1
      .prepare(
        `insert into projects (id, name, repo_path, created_at)
         values ('proj_race', 'race', '/tmp/race', @now)`,
      )
      .run({ now });
    db1
      .prepare(
        `insert into demands (id, title, body, created_at)
         values ('demand_race', 't', 'b', @now)`,
      )
      .run({ now });
    db1
      .prepare(
        `insert into workflow_instances
           (id, project_id, demand_id, status, created_at, updated_at)
         values ('run_race', 'proj_race', 'demand_race', 'paused', @now, @now)`,
      )
      .run({ now });
    const wq1 = createWriteQueue();
    const sessions1 = createSessionEventStore(db1, wq1);
    const jobs1 = createJobRepository(db1, wq1);
    const workspace = await sessions1.getOrCreateDefaultWorkspace('/tmp/race');
    const session = await sessions1.createSession({
      workspaceId: workspace.id,
      title: null,
      profile: 'human-web',
      runId: 'run_race',
    });

    // Connection 2 = a second process sharing the same file, its own WriteQueue.
    const db2 = openTekonDatabase({ filename: file });
    const wq2 = createWriteQueue();
    const jobs2 = createJobRepository(db2, wq2);

    // Both "processes" attempt to resume the same run. Because better-sqlite3 is
    // synchronous, the two IMMEDIATE transactions serialize at the DB writer
    // lock; the first commits its job, the second re-checks inside its own lock,
    // sees the active job, and stands down.
    const [r1, r2] = await Promise.all([
      jobs1.enqueueIfNoActiveByRunId(
        'run_race',
        makeJob(session.id, { id: 'job_conn1', kind: 'workflow-resume' }),
      ),
      jobs2.enqueueIfNoActiveByRunId(
        'run_race',
        makeJob(session.id, { id: 'job_conn2', kind: 'workflow-resume' }),
      ),
    ]);

    const outcomes = [r1.outcome, r2.outcome].sort();
    expect(outcomes).toEqual(['active-job', 'enqueued']);

    // Exactly ONE active job exists for the run across both connections.
    const activeCount = db1
      .prepare(
        `select count(*) as n from jobs j
         join sessions s on s.id = j.session_id
         where s.run_id = 'run_race'
           and j.status in ('queued', 'running', 'paused', 'cancelling')`,
      )
      .get() as { n: number };
    expect(activeCount.n).toBe(1);

    db1.close();
    db2.close();
  });
});

describe('session run id lookup', () => {
  it('getRunIdBySessionId resolves the runId backing a session', async () => {
    const { sessions } = setupStore();
    const { session } = await seedSession(sessions, '/tmp/tekon', 'run_xyz');

    expect(await sessions.getRunIdBySessionId(session.id)).toBe('run_xyz');
    expect(await sessions.getRunIdBySessionId('sess_missing')).toBeNull();
  });

  it('getRunIdBySessionId returns null for a session with no run', async () => {
    const { sessions } = setupStore();
    const workspace = await sessions.getOrCreateDefaultWorkspace('/repo/norun');
    const session = await sessions.createSession({
      workspaceId: workspace.id,
      title: 'no run',
      profile: 'human-web',
      runId: null,
    });
    expect(await sessions.getRunIdBySessionId(session.id)).toBeNull();
  });

  // Phase 3 3a / Phase 4 P1-04: read-path for the Session List UI.
  // listSessions is a pure SELECT scoped to a workspace, ordered by last
  // activity (coalesce(max(events.timestamp), created_at) desc), carrying
  // run_id and lastActivityAt from the query (SessionListEntry).
  it("listSessions returns a workspace's sessions ordered by last activity with runId and lastActivityAt", async () => {
    const { sessions } = setupStore();
    const workspace = await sessions.getOrCreateDefaultWorkspace('/repo/list');
    const first = await sessions.createSession({
      workspaceId: workspace.id,
      title: 'first',
      profile: 'human-web',
      runId: 'run_first',
    });
    const second = await sessions.createSession({
      workspaceId: workspace.id,
      title: 'second',
      profile: 'human-web',
      runId: null,
    });

    // Without events, both fall back to created_at (second was created after first).
    const initialList = await sessions.listSessions(workspace.id);
    expect(initialList.map((s) => s.id)).toEqual([second.id, first.id]);
    expect(initialList.find((s) => s.id === first.id)?.lastActivityAt).toBe(
      first.createdAt,
    );
    expect(initialList.find((s) => s.id === second.id)?.lastActivityAt).toBe(
      second.createdAt,
    );

    // Ensure event timestamp is strictly newer than second.createdAt.
    await new Promise((r) => setTimeout(r, 20));

    // Appending an event to `first` makes its lastActivityAt newer than `second`.
    const event = await sessions.appendEvent({
      sessionId: first.id,
      type: 'agent/message',
      payload: { text: 'activity on first session' },
    });

    const updatedList = await sessions.listSessions(workspace.id);
    // `first` now sorts ahead of `second` because its last event is newest.
    expect(updatedList.map((s) => s.id)).toEqual([first.id, second.id]);
    expect(updatedList[0].lastActivityAt).toBe(event.timestamp);
    expect(updatedList[1].lastActivityAt).toBe(second.createdAt);

    // Appending a second event to `first` advances lastActivityAt to the latest event (seq-desc)
    await new Promise((r) => setTimeout(r, 20));
    const event2 = await sessions.appendEvent({
      sessionId: first.id,
      type: 'agent/message',
      payload: { text: 'second activity on first session' },
    });
    expect(event2.seq).toBeGreaterThan(event.seq);

    const updatedList2 = await sessions.listSessions(workspace.id);
    expect(updatedList2[0].lastActivityAt).toBe(event2.timestamp);

    // runId is carried through from the run_id column (NIT-1), including null.
    const byId = new Map(updatedList.map((s) => [s.id, s.runId]));
    expect(byId.get(first.id)).toBe('run_first');
    expect(byId.get(second.id)).toBeNull();

    // The frozen Session fields are present too.
    expect(updatedList[0]).toMatchObject({
      workspaceId: workspace.id,
      title: 'first',
      profile: 'human-web',
      status: 'active',
      runId: 'run_first',
      lastActivityAt: event.timestamp,
    });
  });

  it('listSessions is scoped to the workspace and returns [] for an unknown one', async () => {
    const { sessions } = setupStore();
    const wsA = await sessions.getOrCreateDefaultWorkspace('/repo/scoped-a');
    const wsB = await sessions.getOrCreateDefaultWorkspace('/repo/scoped-b');
    await sessions.createSession({
      workspaceId: wsA.id,
      title: 'a-only',
      profile: 'human-web',
      runId: 'run_a',
    });

    expect((await sessions.listSessions(wsA.id)).map((s) => s.title)).toEqual([
      'a-only',
    ]);
    expect(await sessions.listSessions(wsB.id)).toEqual([]);
    expect(await sessions.listSessions('ws_does_not_exist')).toEqual([]);
  });

  // getLatestEventTimestamp is the lightweight tail read used by session.get:
  // it returns only the tail event's timestamp (no payload deserialization),
  // sharing listSessions' seq-desc tail semantics.
  it('getLatestEventTimestamp returns null without events and the max-seq event timestamp otherwise', async () => {
    const { sessions } = setupStore();
    const { session } = await seedSession(sessions);

    // No events yet: null (caller falls back to created_at/updated_at).
    expect(await sessions.getLatestEventTimestamp(session.id)).toBeNull();
    expect(
      await sessions.getLatestEventTimestamp('session_does_not_exist'),
    ).toBeNull();

    const first = await sessions.appendEvent({
      sessionId: session.id,
      type: 'agent/message',
      payload: { text: 'first' },
    });
    expect(await sessions.getLatestEventTimestamp(session.id)).toBe(
      first.timestamp,
    );

    await new Promise((r) => setTimeout(r, 20));
    const second = await sessions.appendEvent({
      sessionId: session.id,
      type: 'tool/result',
      payload: { text: 'second' },
    });
    expect(second.seq).toBeGreaterThan(first.seq);
    // Tail is the last appended event (seq-desc), same invariant as listSessions.
    expect(await sessions.getLatestEventTimestamp(session.id)).toBe(
      second.timestamp,
    );
  });

  it('getLatestEventTimestamp is scoped per session', async () => {
    const { sessions } = setupStore();
    const { session: a } = await seedSession(sessions, '/repo/a', 'run_a');
    const { session: b } = await seedSession(sessions, '/repo/b', 'run_b');

    const eventA = await sessions.appendEvent({
      sessionId: a.id,
      type: 'agent/message',
      payload: { text: 'a activity' },
    });
    await new Promise((r) => setTimeout(r, 20));
    const eventB = await sessions.appendEvent({
      sessionId: b.id,
      type: 'agent/message',
      payload: { text: 'b activity' },
    });

    expect(await sessions.getLatestEventTimestamp(a.id)).toBe(
      eventA.timestamp,
    );
    expect(await sessions.getLatestEventTimestamp(b.id)).toBe(
      eventB.timestamp,
    );
  });
});
