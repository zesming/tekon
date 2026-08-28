import { afterEach, describe, expect, it } from 'vitest';

import {
  createJobRepository,
  createSessionEventStore,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  type JobRepository,
} from '../../src/index.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture(): Promise<{
  jobs: JobRepository;
  jobId: string;
}> {
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  cleanups.push(() => db.close());

  const writeQueue = createWriteQueue();
  const sessions = createSessionEventStore(db, writeQueue);
  const jobs = createJobRepository(db, writeQueue);
  const workspace = await sessions.getOrCreateDefaultWorkspace('/repo');
  const session = await sessions.createSession({
    workspaceId: workspace.id,
    title: 'owner fencing',
    profile: 'human-web',
    runId: 'run_owner_fencing',
  });
  const now = new Date().toISOString();
  const job = await jobs.enqueue({
    id: 'job_owner_fencing',
    sessionId: session.id,
    kind: 'workflow-run',
    status: 'running',
    owner: 'worker_new',
    lease: now,
    abortState: 'none',
    checkpoint: 'node:new-owner',
    createdAt: now,
    updatedAt: now,
  });

  return { jobs, jobId: job.id };
}

describe('atomic job owner fencing', () => {
  it('does not write a checkpoint before reporting an owner mismatch', async () => {
    const { jobs, jobId } = await fixture();

    const updated = await jobs.updateJob(
      jobId,
      { checkpoint: 'node:stale-owner' },
      { owner: 'worker_old', statuses: ['running', 'paused'] },
    );

    expect(updated).toBeNull();
    expect(await jobs.get(jobId)).toMatchObject({
      owner: 'worker_new',
      checkpoint: 'node:new-owner',
    });
  });

  it('does not renew a lease after ownership changes', async () => {
    const { jobs, jobId } = await fixture();
    const before = await jobs.get(jobId);

    const updated = await jobs.updateJob(
      jobId,
      { lease: '2099-01-01T00:00:00.000Z' },
      {
        owner: 'worker_old',
        statuses: ['running', 'paused', 'cancelling'],
      },
    );

    expect(updated).toBeNull();
    expect((await jobs.get(jobId))?.lease).toBe(before?.lease);
  });

  it('does not terminalize a job reclaimed by a different owner', async () => {
    const { jobs, jobId } = await fixture();

    const settled = await jobs.settleOwnedJob(
      jobId,
      'worker_old',
      'done',
    );

    expect(settled).toBeNull();
    expect(await jobs.get(jobId)).toMatchObject({
      owner: 'worker_new',
      status: 'running',
      abortState: 'none',
    });
  });

  it('gives a concurrent cancellation request precedence over success', async () => {
    const { jobs, jobId } = await fixture();
    await jobs.updateJob(jobId, {
      status: 'cancelling',
      abortState: 'requested',
    });

    const settled = await jobs.settleOwnedJob(
      jobId,
      'worker_new',
      'done',
    );

    expect(settled).toMatchObject({
      status: 'cancelled',
      abortState: 'stopped',
      owner: 'worker_new',
    });
  });

  it('does not revive a terminal job through a stale pause update', async () => {
    const { jobs, jobId } = await fixture();
    await jobs.updateJob(jobId, {
      status: 'done',
      abortState: 'stopped',
    });

    const paused = await jobs.updateJob(
      jobId,
      { status: 'paused' },
      { statuses: ['running', 'paused'] },
    );

    expect(paused).toBeNull();
    expect(await jobs.get(jobId)).toMatchObject({ status: 'done' });
  });
});
