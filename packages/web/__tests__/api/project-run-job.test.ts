import { afterEach, describe, expect, it } from 'vitest';

import { openTekonDatabase } from '@tekon/core';
import { join } from 'node:path';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

// S7b: project.run/pause/cancel/resume are asynchronous — run/resume enqueue a
// background job and return immediately with { sessionId, jobId }; the durable
// job runner drives the workflow out of band. These tests assert the async
// contract directly (the write-auth suite covers the run-to-passed golden path).
const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

function runStatus(projectRoot: string, runId: string): string | undefined {
  const db = openTekonDatabase({
    filename: join(projectRoot, '.tekon', 'tekon.sqlite'),
  });
  try {
    const row = db
      .prepare('select status from workflow_instances where id = ?')
      .get(runId) as { status: string } | undefined;
    return row?.status;
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

describe('project.run background job (S7b)', () => {
  it('returns sessionId/jobId immediately and drives the run to passed in the background', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const startedAt = Date.now();
    const started = await api.project.run({
      demandText: 'Background job should drive this run.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });
    // RPC returns fast (does not block on the agent loop).
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(started.sessionId).toBeTruthy();
    expect(started.jobId).toBeTruthy();

    await waitFor(
      () => runStatus(fixture.projectRoot, started.run.id) === 'passed',
    );

    await api.close();
  }, 30_000);

  it('MF2: resume is rejected with 409 while a job is active for the run', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const started = await api.project.run({
      demandText: 'Two active jobs per run are not allowed.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });

    // Let the run's own job finish, then deterministically seed a fresh active
    // job (fresh lease) for the same run so the resume guard has something to
    // reject — the mock agent is too fast to reliably observe the run's own job
    // mid-flight.
    await waitFor(
      () => runStatus(fixture.projectRoot, started.run.id) === 'passed',
    );
    const db = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    try {
      const sessionId = started.sessionId!;
      const nowIso = new Date().toISOString();
      db.prepare(
        `insert into jobs (id, session_id, kind, status, owner, lease, abort_state, checkpoint, payload, created_at, updated_at)
         values (@id, @sessionId, 'workflow-resume', 'running', 'other-worker', @lease, 'none', null, '{}', @now, @now)`,
      ).run({ id: 'job_active_seed', sessionId, lease: nowIso, now: nowIso });
    } finally {
      db.close();
    }

    // The run is terminal (passed) so M8 would 400 first; use a non-terminal
    // status to exercise the MF2 guard. Flip it back to running for the check.
    const db2 = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    try {
      db2
        .prepare(`update workflow_instances set status = 'paused' where id = ?`)
        .run(started.run.id);
    } finally {
      db2.close();
    }

    await expect(
      api.project.resume({ runId: started.run.id, token: fixture.sessionToken }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    await api.close();
  }, 30_000);

  it('M2: repeat cancel on an already-cancelled run is idempotent (no error)', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const started = await api.project.run({
      demandText: 'Cancel then cancel again.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });

    const first = await api.project.cancel({
      runId: started.run.id,
      token: fixture.sessionToken,
    });
    // First cancel either wins (cancelled) or the run already passed; both are
    // valid terminal outcomes. A second cancel must not throw either way.
    const second = await api.project.cancel({
      runId: started.run.id,
      token: fixture.sessionToken,
    });
    expect(['cancelled', 'passed', 'failed']).toContain(second.run.status);
    void first;

    // Wait for any in-flight job to settle before closing (avoids stop() cutting
    // an in-flight job).
    await waitFor(() => {
      const s = runStatus(fixture.projectRoot, started.run.id);
      return s === 'cancelled' || s === 'passed' || s === 'failed';
    });
    await api.close();
  }, 30_000);

  it('M8: resume on a terminal run is rejected with 400', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const started = await api.project.run({
      demandText: 'Terminal runs cannot be resumed.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });
    await waitFor(
      () => runStatus(fixture.projectRoot, started.run.id) === 'passed',
    );

    await expect(
      api.project.resume({ runId: started.run.id, token: fixture.sessionToken }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  }, 30_000);

  it('SHOULD16: pause on a terminal run is rejected with 400 and does not change status', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const started = await api.project.run({
      demandText: 'Passed runs cannot be paused.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });
    await waitFor(
      () => runStatus(fixture.projectRoot, started.run.id) === 'passed',
    );

    await expect(
      api.project.pause({ runId: started.run.id, token: fixture.sessionToken }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(runStatus(fixture.projectRoot, started.run.id)).toBe('passed');

    await api.close();
  }, 30_000);

  it('MF1: cancel emits agent/cancel-requested and agent/cancelled exactly once', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const started = await api.project.run({
      demandText: 'Cancel should emit terminal session events.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });
    const sessionId = started.sessionId!;

    const result = await api.project.cancel({
      runId: started.run.id,
      token: fixture.sessionToken,
    });

    // If cancel won the race (written=true), the session must carry exactly one
    // cancel-requested + one cancelled event. If the run had already passed,
    // cancel is a no-op and emits nothing — assert accordingly.
    await waitFor(() => {
      const s = runStatus(fixture.projectRoot, started.run.id);
      return s === 'cancelled' || s === 'passed';
    });

    const db = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    try {
      const rows = db
        .prepare(
          `select type, count(*) as n from session_events
           where session_id = ? and type in ('agent/cancel-requested','agent/cancelled')
           group by type`,
        )
        .all(sessionId) as Array<{ type: string; n: number }>;
      const counts = Object.fromEntries(rows.map((r) => [r.type, r.n]));
      if (result.run.status === 'cancelled') {
        expect(counts['agent/cancel-requested']).toBe(1);
        expect(counts['agent/cancelled']).toBe(1);
      } else {
        // Run already passed before cancel landed: no cancel events emitted.
        expect(counts['agent/cancelled'] ?? 0).toBe(0);
      }
    } finally {
      db.close();
    }

    await api.close();
  }, 30_000);

  // 4b: goal mode runs the built-in single-node goal template end-to-end.
  it('runs a goal-mode run to passed via the built-in goal template', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const started = await api.project.run({
      demandText: 'Do a lightweight one-off task.',
      mode: 'goal',
      agent: 'mock',
      token: fixture.sessionToken,
    });
    expect(started.sessionId).toBeTruthy();
    expect(started.jobId).toBeTruthy();

    await waitFor(
      () => runStatus(fixture.projectRoot, started.run.id) === 'passed',
    );

    // The run is persisted as kind='goal' and the opening workflow/started
    // event carries kind:'goal' (not 'workflow').
    const db = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    try {
      const inst = db
        .prepare('select kind from workflow_instances where id = ?')
        .get(started.run.id) as { kind: string } | undefined;
      expect(inst?.kind).toBe('goal');
      const startEvent = db
        .prepare(
          `select payload from session_events
           where session_id = ? and type = 'workflow/started' limit 1`,
        )
        .get(started.sessionId!) as { payload: string } | undefined;
      expect(startEvent).toBeTruthy();
      expect(JSON.parse(startEvent!.payload).kind).toBe('goal');
    } finally {
      db.close();
    }

    await api.close();
  }, 30_000);

  // 4b (§0.3 hard constraint): an unknown job kind must FAIL, never fall through
  // to executePreparedRun and silently settle run.passed. This seeds an
  // unknown-kind job on a genuinely prepared (non-terminal, non-empty plan) run
  // so the assertion pins the kind-dispatch path, not the no-runId guard.
  it('fails an unknown job kind instead of silently passing the run', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    // A real prepared run + session (kind bound, plan persisted), then flip the
    // run back to running so it is non-terminal when the bogus job claims it.
    const started = await api.project.run({
      demandText: 'Prepared run for the unknown-kind guard.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });
    await waitFor(
      () => runStatus(fixture.projectRoot, started.run.id) === 'passed',
    );

    const db = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    try {
      db.prepare(`update workflow_instances set status = 'running' where id = ?`)
        .run(started.run.id);
      const nowIso = new Date().toISOString();
      db.prepare(
        `insert into jobs (id, session_id, kind, status, owner, lease, abort_state, checkpoint, payload, created_at, updated_at)
         values (@id, @sessionId, 'bogus-kind', 'queued', null, null, 'none', null, '{}', @now, @now)`,
      ).run({ id: 'job_bogus', sessionId: started.sessionId!, now: nowIso });
    } finally {
      db.close();
    }

    // The durable runner claims + executes the bogus job; the executor's
    // explicit dispatch throws → job failed, and the run is NOT written passed
    // by this path (it is left running, since the bogus job cannot advance it).
    await waitFor(() => {
      const check = openTekonDatabase({
        filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
      });
      try {
        const job = check
          .prepare('select status from jobs where id = ?')
          .get('job_bogus') as { status: string } | undefined;
        return job?.status === 'failed';
      } finally {
        check.close();
      }
    });
    // The bogus job did not settle the run passed.
    expect(runStatus(fixture.projectRoot, started.run.id)).toBe('running');

    await api.close();
  }, 30_000);
});
