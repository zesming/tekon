import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

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

    const e1 = await sessions.appendEvent({ sessionId: a.id, type: 'turn/start' });
    const e2 = await sessions.appendEvent({ sessionId: a.id, type: 'turn/end' });
    const e3 = await sessions.appendEvent({ sessionId: b.id, type: 'turn/start' });
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
      makeJob(session.id, { id: 'job_running', status: 'running', owner: 'w1', lease: stale }),
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
      makeJob(session.id, { id: 'job_paused', status: 'paused', owner: 'w1', lease: stale }),
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
      makeJob(session.id, { id: 'job_live', status: 'running', owner: 'w1', lease: fresh }),
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
    const stale = '2026-08-20T00:00:00.000Z';
    const fresh = '2026-08-21T12:00:00.000Z';

    await jobs.enqueue(makeJob(session.id, { id: 'job_queued' }));
    await jobs.enqueue(
      makeJob(session.id, { id: 'job_stale_paused', status: 'paused', owner: 'w1', lease: stale }),
    );
    await jobs.enqueue(
      makeJob(session.id, { id: 'job_live_paused', status: 'paused', owner: 'w1', lease: fresh }),
    );
    await jobs.enqueue(
      makeJob(session.id, { id: 'job_running', status: 'running', owner: 'w1', lease: fresh }),
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
    await jobs.enqueue(makeJob(session.id, { id: 'job_except', status: 'queued' }));

    const count = await jobs.cancelStaleActiveJobs('run_1', 'job_except');
    expect(count).toBe(2);

    expect(await jobs.get('job_queued')).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
    expect(await jobs.get('job_stale_paused')).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
    });
    expect(await jobs.get('job_live_paused')).toMatchObject({ status: 'paused' });
    expect(await jobs.get('job_running')).toMatchObject({ status: 'running' });
    expect(await jobs.get('job_cancelling')).toMatchObject({ status: 'cancelling' });
    expect(await jobs.get('job_except')).toMatchObject({ status: 'queued' });

    // A run without sessions/jobs is a no-op.
    expect(await jobs.cancelStaleActiveJobs('run_missing')).toBe(0);
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
      makeJob(session.id, { id: 'job_paused_old', status: 'paused', owner: 'w1', lease: staleLease }),
    );
    await jobs.enqueue(
      makeJob(session.id, { id: 'job_paused_new', status: 'paused', owner: 'w1', lease: freshLease }),
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
    expect(await jobs.get('job_paused_new')).toMatchObject({ status: 'paused' });

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
    expect(await jobs.get('job_paused_new')).toMatchObject({ status: 'paused' });
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
});
