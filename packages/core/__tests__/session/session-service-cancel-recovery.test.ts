import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createAuditLogger,
  createJobRepository,
  createJobRunner,
  createRepositories,
  createSessionEventBus,
  createSessionEventStore,
  createSessionService,
  createSubprocessRegistry,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

async function setup() {
  const projectRoot = mkdtempSync(join(tmpdir(), 'tekon-cancel-recovery-'));
  cleanups.push(() => rmSync(projectRoot, { recursive: true, force: true }));
  const db = openTekonDatabase({ filename: ':memory:' });
  cleanups.push(() => db.close());
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  const repositories = createRepositories(db, writeQueue);
  const sessions = createSessionEventStore(db, writeQueue);
  const jobs = createJobRepository(db, writeQueue);
  const bus = createSessionEventBus();
  const audit = createAuditLogger({ repositories, db, writeQueue });
  const jobRunner = createJobRunner({
    jobs, sessions, bus, registry: createSubprocessRegistry(),
    executor: { execute: async () => { throw new Error('Execution is not started in this test'); } },
  });
  const now = new Date().toISOString();
  await repositories.createProject({ id: 'project', name: 'Cancel recovery', repoPath: projectRoot, createdAt: now });
  await repositories.createDemand({ id: 'demand', title: 'Cancel recovery', body: 'Test', createdAt: now });
  await repositories.createWorkflowInstance({
    id: 'run', projectId: 'project', demandId: 'demand', status: 'running', createdAt: now, updatedAt: now,
  });
  const workspace = await sessions.getOrCreateDefaultWorkspace(projectRoot);
  const session = await sessions.createSession({ workspaceId: workspace.id, title: null, profile: 'human-web', runId: 'run' });
  const job = await jobRunner.enqueue({ sessionId: session.id, kind: 'workflow-run' });
  const service = createSessionService({
    sessions, jobs, jobRunner, bus, repositories, audit, projectRoot,
    createEngine: () => { throw new Error('Cancellation must not build an engine'); },
  });
  return { repositories, sessions, jobs, jobRunner, service, session, job };
}

describe('cancel delivery is independent of observation and repeat terminal writes', () => {
  it('delivers cancellation before a cancel-requested event write fails', async () => {
    const env = await setup();
    const append = env.sessions.appendEvent.bind(env.sessions);
    vi.spyOn(env.sessions, 'appendEvent').mockImplementation(async input => {
      if (input.type === 'agent/cancel-requested') throw new Error('event write failed');
      return append(input);
    });
    await expect(env.service.requestCancel({ runId: 'run' })).rejects.toThrow('event write failed');
    expect((await env.repositories.getWorkflowInstance('run'))?.status).toBe('cancelled');
    expect((await env.jobs.get(env.job.id))?.status).toBe('cancelled');
    // Do not claim that the missing observation event was repaired.
    expect((await env.sessions.listEventsSince(env.session.id, 0)).filter(event => event.type === 'agent/cancel-requested')).toEqual([]);
  });

  it('retries job cancellation even when the first request already wrote the run terminal state', async () => {
    const env = await setup();
    const cancel = vi.spyOn(env.jobRunner, 'requestCancel').mockRejectedValueOnce(new Error('job update failed'));
    await expect(env.service.requestCancel({ runId: 'run' })).rejects.toThrow('job update failed');
    expect((await env.repositories.getWorkflowInstance('run'))?.status).toBe('cancelled');
    expect((await env.jobs.get(env.job.id))?.status).toBe('queued');
    const result = await env.service.requestCancel({ runId: 'run' });
    expect(result).toMatchObject({ terminalConflict: false, jobId: env.job.id });
    expect(cancel).toHaveBeenCalledTimes(2);
    expect((await env.jobs.get(env.job.id))?.status).toBe('cancelled');
  });

  it('reconciles a cancelled run with a still-owned job using the existing durable cancel protocol', async () => {
    const env = await setup();
    expect((await env.jobs.claimNext('another-worker'))?.id).toBe(env.job.id);
    await env.repositories.updateWorkflowInstanceStatus('run', 'cancelled', null);
    await env.service.requestCancel({ runId: 'run' });
    expect(await env.jobs.get(env.job.id)).toMatchObject({
      status: 'cancelling', abortState: 'requested', owner: 'another-worker',
    });
    // This proves durable delivery, not that a foreign process has exited.
    expect(await env.sessions.listEventsSince(env.session.id, 0)).toEqual([]);
  });

  it('does not let a Session lookup failure prevent job cancellation', async () => {
    const env = await setup();
    vi.spyOn(env.sessions, 'findSessionByRunId').mockRejectedValueOnce(new Error('session read failed'));
    await expect(env.service.requestCancel({ runId: 'run' })).rejects.toThrow('session read failed');
    expect((await env.jobs.get(env.job.id))?.status).toBe('cancelled');
  });

  it('keeps normal repeat cancellation free of duplicate lifecycle events', async () => {
    const env = await setup();
    await env.service.requestCancel({ runId: 'run' });
    await env.service.requestCancel({ runId: 'run' });
    const events = await env.sessions.listEventsSince(env.session.id, 0);
    expect(events.filter(event => event.type === 'agent/cancel-requested')).toHaveLength(1);
    expect(events.filter(event => event.type === 'agent/cancelled')).toHaveLength(1);
  });

  it.each(['passed', 'failed'] as const)('does not cancel an active job when %s already won the run terminal state', async status => {
    const env = await setup();
    await env.repositories.updateWorkflowInstanceStatus('run', status, null);
    const cancel = vi.spyOn(env.jobRunner, 'requestCancel');
    expect(await env.service.requestCancel({ runId: 'run' })).toEqual({ runId: 'run', terminalConflict: true });
    expect(cancel).not.toHaveBeenCalled();
    expect((await env.jobs.get(env.job.id))?.status).toBe('queued');
    expect(await env.sessions.listEventsSince(env.session.id, 0)).toEqual([]);
  });
});
