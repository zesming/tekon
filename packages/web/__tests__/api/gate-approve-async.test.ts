import { afterEach, describe, expect, it } from 'vitest';

import { openTekonDatabase } from '@tekon/core';
import { join } from 'node:path';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

// S7d/M9: gate.approve flips the human decision synchronously, reclaims any
// safe stale jobs for the run (S3), binds a session, and enqueues a background
// workflow-resume job (P0-02: resume is no longer a blocking call). These tests
// pin the async contract that the write-auth golden path does not isolate:
// the return shape, the stale-job reclaim, and the eventual resume-to-passed.
const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

function openDb(projectRoot: string) {
  return openTekonDatabase({
    filename: join(projectRoot, '.tekon', 'tekon.sqlite'),
  });
}

function runStatus(projectRoot: string, runId: string): string | undefined {
  const db = openDb(projectRoot);
  try {
    const row = db
      .prepare('select status from workflow_instances where id = ?')
      .get(runId) as { status: string } | undefined;
    return row?.status;
  } finally {
    db.close();
  }
}

function jobStatus(projectRoot: string, jobId: string): string | undefined {
  const db = openDb(projectRoot);
  try {
    const row = db
      .prepare('select status from jobs where id = ?')
      .get(jobId) as { status: string } | undefined;
    return row?.status;
  } finally {
    db.close();
  }
}

/** Force run_1 into a terminal status while leaving decision_1 pending, so the
 * approve/reject terminal guard (M8/MF3) is the first thing hit. */
function setRunStatus(projectRoot: string, runId: string, status: string): void {
  const db = openDb(projectRoot);
  try {
    db.prepare('update workflow_instances set status = ? where id = ?').run(
      status,
      runId,
    );
  } finally {
    db.close();
  }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() >= deadline) {
      throw new Error('waitFor: condition not met before timeout');
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('gate.approve async resume (S7d)', () => {
  it('reclaims a stale queued resume job (S3) before enqueuing a fresh one, then drives the run to passed', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    // Seed a session bound to run_1 plus a leftover OLD queued resume job for
    // it (created_at in the distant past). cancelStaleActiveJobs reclaims only
    // aged queued jobs (A1: a fresh queued job is a concurrent enqueue and must
    // survive), so this stale one is cancelled before approve enqueues the real
    // one — two active jobs never race the same run (S3/MF2).
    const seedDb = openDb(fixture.projectRoot);
    try {
      const nowIso = new Date().toISOString();
      // A workspace + session are required by the sessions FK / run binding.
      seedDb
        .prepare(
          `insert into workspaces (id, root, created_at)
           values (@id, @root, @now)
           on conflict(id) do nothing`,
        )
        .run({ id: 'ws_seed', root: fixture.projectRoot, now: nowIso });
      seedDb
        .prepare(
          `insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
           values (@id, 'ws_seed', null, 'human-web', 'idle', 'run_1', @now, @now)`,
        )
        .run({ id: 'sess_seed', now: nowIso });
      seedDb
        .prepare(
          `insert into jobs (id, session_id, kind, status, owner, lease, abort_state, checkpoint, payload, created_at, updated_at)
           values ('job_stale_queued', 'sess_seed', 'workflow-resume', 'queued', null, null, 'none', null, '{}', @staleNow, @staleNow)`,
        )
        .run({ staleNow: '2020-01-01T00:00:00.000Z' });
    } finally {
      seedDb.close();
    }

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.gate.approve({
      runId: 'run_1',
      decisionId: 'decision_1',
      actor: 'human-reviewer',
      note: 'approve with a stale queued job present',
      token: fixture.sessionToken,
    });

    expect(result.decision).toMatchObject({
      id: 'decision_1',
      status: 'approved',
    });
    expect(result.sessionId).toBeTruthy();
    expect(result.jobId).toBeTruthy();
    // The fresh job must not be the stale one.
    expect(result.jobId).not.toBe('job_stale_queued');

    // S3: the pre-existing queued job was reclaimed (cancelled) so it can never
    // be claimed and double-drive the run.
    expect(jobStatus(fixture.projectRoot, 'job_stale_queued')).toBe('cancelled');

    // The enqueued resume job drives run_1 to passed out of band.
    await waitFor(() => runStatus(fixture.projectRoot, 'run_1') === 'passed');

    const audit = await api.audit.list({ runId: 'run_1' });
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'human.gate.approved' }),
        expect.objectContaining({ type: 'run.resumed' }),
      ]),
    );

    await api.close();
    // After close() awaits the in-flight job, it has settled to done.
    expect(jobStatus(fixture.projectRoot, result.jobId!)).toBe('done');
  }, 30_000);

  it('rebinds the existing run-bound session instead of creating a duplicate', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    // Pre-bind a session to run_1; approve must reuse it (findSessionByRunId),
    // not create a second session for the same run.
    const seedDb = openDb(fixture.projectRoot);
    try {
      const nowIso = new Date().toISOString();
      seedDb
        .prepare(
          `insert into workspaces (id, root, created_at)
           values (@id, @root, @now)
           on conflict(id) do nothing`,
        )
        .run({ id: 'ws_seed', root: fixture.projectRoot, now: nowIso });
      seedDb
        .prepare(
          `insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
           values (@id, 'ws_seed', null, 'human-web', 'idle', 'run_1', @now, @now)`,
        )
        .run({ id: 'sess_prebound', now: nowIso });
    } finally {
      seedDb.close();
    }

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.gate.approve({
      runId: 'run_1',
      decisionId: 'decision_1',
      actor: 'human-reviewer',
      token: fixture.sessionToken,
    });

    expect(result.sessionId).toBe('sess_prebound');

    await waitFor(() => runStatus(fixture.projectRoot, 'run_1') === 'passed');

    const db = openDb(fixture.projectRoot);
    try {
      const count = (
        db
          .prepare('select count(*) as n from sessions where run_id = ?')
          .get('run_1') as { n: number }
      ).n;
      expect(count).toBe(1);
    } finally {
      db.close();
    }

    await api.close();
  }, 30_000);

  it('M8: approve on a terminal run is rejected with 400 and does not flip the decision', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    // run_1 is paused with pending decision_1; force it terminal so the M8
    // guard (not the decision-status guard) is what rejects the approve.
    setRunStatus(fixture.projectRoot, 'run_1', 'cancelled');
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // Decision stays pending; run stays terminal; no resume job created.
    const gates = await api.gate.list({ runId: 'run_1' });
    expect(gates.pendingDecisions).toContainEqual(
      expect.objectContaining({ id: 'decision_1', status: 'pending' }),
    );
    expect(runStatus(fixture.projectRoot, 'run_1')).toBe('cancelled');

    await api.close();
  }, 30_000);

  it('MF3: reject on a terminal run is rejected with 400 (no cancelled→reject→resume revival)', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    setRunStatus(fixture.projectRoot, 'run_1', 'cancelled');
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.gate.reject({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'reject after terminal',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    // The run must NOT be flipped to blocked (which would re-open resume).
    expect(runStatus(fixture.projectRoot, 'run_1')).toBe('cancelled');
    const gates = await api.gate.list({ runId: 'run_1' });
    expect(gates.pendingDecisions).toContainEqual(
      expect.objectContaining({ id: 'decision_1', status: 'pending' }),
    );

    await api.close();
  }, 30_000);

  it('MF2: approve is rejected with 409 while a live job is active for the run', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    // Seed a session bound to run_1 and a LIVE running job (fresh lease) that
    // cancelStaleActiveJobs will not reclaim. approve must mirror project.resume
    // and 409 rather than enqueue a second resume job (double-drive guard).
    const seedDb = openDb(fixture.projectRoot);
    try {
      const nowIso = new Date().toISOString();
      seedDb
        .prepare(
          `insert into workspaces (id, root, created_at)
           values (@id, @root, @now)
           on conflict(id) do nothing`,
        )
        .run({ id: 'ws_live', root: fixture.projectRoot, now: nowIso });
      seedDb
        .prepare(
          `insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
           values (@id, 'ws_live', null, 'human-web', 'active', 'run_1', @now, @now)`,
        )
        .run({ id: 'sess_live', now: nowIso });
      seedDb
        .prepare(
          `insert into jobs (id, session_id, kind, status, owner, lease, abort_state, checkpoint, payload, created_at, updated_at)
           values ('job_live_running', 'sess_live', 'workflow-resume', 'running', 'other-worker', @lease, 'none', null, '{}', @now, @now)`,
        )
        .run({ lease: nowIso, now: nowIso });
    } finally {
      seedDb.close();
    }

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // The decision was NOT flipped and no second resume job was enqueued.
    const gates = await api.gate.list({ runId: 'run_1' });
    expect(gates.pendingDecisions).toContainEqual(
      expect.objectContaining({ id: 'decision_1', status: 'pending' }),
    );
    const db = openDb(fixture.projectRoot);
    try {
      const jobs = db
        .prepare(
          `select count(*) as n from jobs j
           join sessions s on s.id = j.session_id
           where s.run_id = 'run_1' and j.kind = 'workflow-resume'`,
        )
        .get() as { n: number };
      expect(jobs.n).toBe(1); // only the seeded live job; approve added none.
    } finally {
      db.close();
    }

    await api.close();
  }, 30_000);

  it('A1: two concurrent approves — exactly one wins with a live job, the other 409s, winner drives to passed', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    // Fire both approves without awaiting between them so their reclaim/CAS/
    // enqueue steps interleave on the shared write queue. Exactly one must win
    // (200 + a job that actually drives the run); the other must 409 WITHOUT
    // cancelling the winner's freshly-enqueued job (the A1 regression: an age-
    // less queued reclaim would kill the winner's job → run stuck at paused).
    const results = await Promise.allSettled([
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'reviewer-a',
        token: fixture.sessionToken,
      }),
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'reviewer-b',
        token: fixture.sessionToken,
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<
      PromiseFulfilledResult<{ decision: unknown; jobId?: string }>
    >;
    const rejected = results.filter((r) => r.status === 'rejected') as Array<
      PromiseRejectedResult
    >;
    // Exactly one winner, one loser (409 CONFLICT).
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({ code: 'CONFLICT' });

    const winnerJobId = fulfilled[0].value.jobId!;
    expect(winnerJobId).toBeTruthy();

    // The winner's job survives the loser's reclaim and drives the run to passed.
    await waitFor(() => runStatus(fixture.projectRoot, 'run_1') === 'passed');
    expect(['done', 'running', 'queued']).toContain(
      jobStatus(fixture.projectRoot, winnerJobId),
    );

    // Exactly one resume job exists for the run (the loser enqueued none).
    const db = openDb(fixture.projectRoot);
    try {
      const n = (
        db
          .prepare(
            `select count(*) as n from jobs j
             join sessions s on s.id = j.session_id
             where s.run_id = 'run_1' and j.kind = 'workflow-resume'`,
          )
          .get() as { n: number }
      ).n;
      expect(n).toBe(1);
    } finally {
      db.close();
    }

    await api.close();
  }, 30_000);

  it('P0-02: a resume job enqueued by approve can be cancelled mid-flight', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const approved = await api.gate.approve({
      runId: 'run_1',
      decisionId: 'decision_1',
      actor: 'human-reviewer',
      token: fixture.sessionToken,
    });
    expect(approved.jobId).toBeTruthy();

    // Cancel the run: project.cancel writes the terminal status and the job
    // runner aborts the active resume job. P0-02: resume is cancellable — the
    // run must reach a terminal state and the resume job must not stay active.
    await api.project.cancel({
      runId: 'run_1',
      token: fixture.sessionToken,
    });

    await waitFor(() => {
      const s = runStatus(fixture.projectRoot, 'run_1');
      return s === 'cancelled' || s === 'passed';
    });
    // The enqueued resume job settles (cancelled if the abort won, done if the
    // mock agent finished first) — never left active/queued.
    await waitFor(() => {
      const s = jobStatus(fixture.projectRoot, approved.jobId!);
      return s === 'cancelled' || s === 'done' || s === 'failed';
    });
    const finalJob = jobStatus(fixture.projectRoot, approved.jobId!);
    expect(['cancelled', 'done', 'failed']).toContain(finalJob);

    await api.close();
  }, 30_000);

  it('S1: reject is rejected with 409 while a live job is active for the run (no misleading 200)', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);

    // Seed a session bound to run_1 and a LIVE running job (fresh lease). This
    // models a resume driving the run (status transiently `running`) while a
    // second pending decision is rejected. Before the fix, reject flipped the
    // decision + node but its run-level CAS (paused→blocked) no-oped (run is
    // running), so it returned a misleading 200 with the run stuck non-blocked.
    // The single-active-job guard now covers reject too → clean 409, no writes.
    const seedDb = openDb(fixture.projectRoot);
    try {
      const nowIso = new Date().toISOString();
      seedDb
        .prepare(
          `insert into workspaces (id, root, created_at)
           values (@id, @root, @now)
           on conflict(id) do nothing`,
        )
        .run({ id: 'ws_live', root: fixture.projectRoot, now: nowIso });
      seedDb
        .prepare(
          `insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
           values (@id, 'ws_live', null, 'human-web', 'active', 'run_1', @now, @now)`,
        )
        .run({ id: 'sess_live', now: nowIso });
      seedDb
        .prepare(
          `insert into jobs (id, session_id, kind, status, owner, lease, abort_state, checkpoint, payload, created_at, updated_at)
           values ('job_live_running', 'sess_live', 'workflow-resume', 'running', 'other-worker', @lease, 'none', null, '{}', @now, @now)`,
        )
        .run({ lease: nowIso, now: nowIso });
    } finally {
      seedDb.close();
    }

    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.gate.reject({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'reject while a resume job is live',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    // No side effects: the decision stays pending, the run stays paused (NOT
    // flipped to blocked underneath a live job), and no audit reject landed.
    const gates = await api.gate.list({ runId: 'run_1' });
    expect(gates.pendingDecisions).toContainEqual(
      expect.objectContaining({ id: 'decision_1', status: 'pending' }),
    );
    expect(runStatus(fixture.projectRoot, 'run_1')).toBe('paused');
    const audits = await api.audit.list({ runId: 'run_1' });
    expect(
      audits.events.some((e) => e.type === 'human.gate.rejected'),
    ).toBe(false);

    await api.close();
  }, 30_000);
});
