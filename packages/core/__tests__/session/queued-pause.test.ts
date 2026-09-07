import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanupQueuedPause, setup, waitFor } from './queued-pause-fixture.js';
afterEach(cleanupQueuedPause);

describe('R27 pause before an initial Job is claimed', () => {
  it.each(['workflow', 'goal'] as const)('%s does not launch an Agent until explicit resume', async mode => {
    const f = await setup(mode);
    const { runId, jobId, sessionId } = f.admitted;
    expect((await f.jobs.get(jobId))?.status).toBe('queued');
    expect((await f.service.requestPause({ runId })).outcome).toBe('paused');
    f.runner.start();
    await waitFor(async () => ['done', 'failed'].includes((await f.jobs.get(jobId))?.status ?? ''));
    expect((await f.jobs.get(jobId))?.status).toBe('done');
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('paused');
    expect((await f.sessions.getSession(sessionId))?.status).toBe('idle');
    expect(f.roleCount()).toBe(0);
    expect((await f.jobs.get(jobId))?.exitEvidence?.kind).toBe('managed-handles-closed');
    const resumed = await f.service.resumeRun({ runId });
    expect(resumed.outcome).toBe('enqueued');
    if (resumed.outcome !== 'enqueued') throw new Error('Resume rejected');
    expect(resumed.jobId).not.toBe(jobId);
    await waitFor(async () => ['done', 'failed'].includes((await f.jobs.get(resumed.jobId))?.status ?? ''));
    expect((await f.jobs.get(resumed.jobId))?.status).toBe('done');
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('passed');
    expect(f.roleCount()).toBe(1);
  }, 15000);

  it('resume before claim keeps the original Job and clears the durable pause', async () => {
    const f = await setup(); const { runId, jobId } = f.admitted;
    await f.service.requestPause({ runId });
    expect(await f.service.resumeRun({ runId })).toMatchObject({ outcome: 'enqueued', jobId });
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('running');
    expect(f.db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
    f.runner.start();
    await waitFor(async () => ['done', 'failed'].includes((await f.jobs.get(jobId))?.status ?? ''));
    expect((await f.jobs.get(jobId))?.status).toBe('done');
    expect(f.roleCount()).toBe(1);
  }, 15000);

  it.each(['cancelled', 'passed', 'failed'] as const)('queued resume cannot overwrite a racing %s winner', async status => {
    const f = await setup(); const { runId } = f.admitted;
    await f.service.requestPause({ runId });
    const get = f.jobs.get.bind(f.jobs);
    const enqueue = f.jobs.enqueueIfNoActiveByRunId.bind(f.jobs);
    const win = () => f.db.prepare('update workflow_instances set status=? where id=?').run(status, runId);
    vi.spyOn(f.jobs, 'get').mockImplementationOnce(async id => {
      const job = await get(id); win(); return job;
    });
    vi.spyOn(f.jobs, 'enqueueIfNoActiveByRunId').mockImplementationOnce(async (...args) => {
      win(); return enqueue(...args);
    });
    expect(await f.service.resumeRun({ runId })).toMatchObject({ outcome: 'terminal', status });
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe(status);
    expect(f.roleCount()).toBe(0);
    expect(f.db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
  });

  it.each(['workflow', 'goal'] as const)('%s resumes after another owner drains the Job during the request', async mode => {
    const f = await setup(mode); const { runId, jobId } = f.admitted;
    await f.service.requestPause({ runId });
    const get = f.jobs.get.bind(f.jobs);
    const enqueue = f.jobs.enqueueIfNoActiveByRunId.bind(f.jobs);
    let drained = false;
    const drain = async () => {
      if (drained) return;
      drained = true;
      f.runner.start();
      await waitFor(async () => (await get(jobId))?.status === 'done');
      expect(f.roleCount()).toBe(0);
      expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('paused');
    };
    // Baseline pauses after its read; the atomic implementation pauses before
    // its transaction. Both allow the real owner/executor to finish first.
    vi.spyOn(f.jobs, 'get').mockImplementationOnce(async id => {
      const snapshot = await get(id); await drain(); return snapshot;
    });
    vi.spyOn(f.jobs, 'enqueueIfNoActiveByRunId').mockImplementationOnce(async (...args) => {
      await drain(); return enqueue(...args);
    });
    const resumed = await f.service.resumeRun({ runId });
    expect(drained).toBe(true);
    expect(resumed.outcome).toBe('enqueued');
    if (resumed.outcome !== 'enqueued') throw Error('Resume rejected');
    expect(resumed.jobId).not.toBe(jobId);
    await waitFor(async () => (await get(resumed.jobId))?.status === 'done');
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('passed');
    expect(f.roleCount()).toBe(1);
  }, 15000);

  it('queued reuse rejects a stale explicit previous-Job confirmation', async () => {
    const f = await setup(); const { runId, jobId } = f.admitted;
    await f.service.requestPause({ runId });
    expect(await f.service.resumeRun({ runId, confirmStopped: true, previousJobId: 'older-generation' }))
      .toMatchObject({ outcome: 'stale-confirmation', previousJobId: jobId });
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('paused');
    expect((await f.jobs.get(jobId))?.status).toBe('queued');
  });

  it('a claimed initial Job returns active-job without releasing the pause', async () => {
    const f = await setup(); const { runId, jobId } = f.admitted;
    await f.service.requestPause({ runId });
    expect((await f.jobs.claimNext('other-owner'))?.id).toBe(jobId);
    expect(await f.service.resumeRun({ runId })).toMatchObject({ outcome: 'active-job' });
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('paused');
    expect(f.db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
  });

  it('a database error while releasing queued pause rolls back the request', async () => {
    const f = await setup(); const { runId, jobId } = f.admitted;
    await f.service.requestPause({ runId });
    f.db.exec("create trigger reject_resume before update of status on workflow_instances when new.status='running' begin select raise(abort, 'resume-write-failed'); end");
    await expect(f.service.resumeRun({ runId })).rejects.toThrow('resume-write-failed');
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('paused');
    expect((await f.jobs.get(jobId))?.status).toBe('queued');
    expect(f.db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
    f.db.exec('drop trigger reject_resume');
    expect(await f.service.resumeRun({ runId })).toMatchObject({ outcome: 'enqueued', jobId });
  });

});
