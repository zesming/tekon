import { afterEach, describe, expect, it } from 'vitest';
import { parallelDatabaseProcesses } from '../db/admission-fixture.js';
import { cleanupQueuedPause, setup, waitFor } from './queued-pause-fixture.js';

afterEach(cleanupQueuedPause);

function resumeScript(root: string, runId: string): string {
  const source = new URL('../../src/index.ts', import.meta.url).href;
  return `const t = await import(${JSON.stringify(source)});
const sessions=t.createSessionEventStore(db,writeQueue),jobs=t.createJobRepository(db,writeQueue),bus=t.createSessionEventBus(),audit=t.createAuditLogger({repositories}),registry=t.createSubprocessRegistry();
const runner=t.createJobRunner({sessions,jobs,bus,registry,executor:t.createWorkflowJobExecutor({repositories,sessions,bus,audit,registry,projectContext:{projectRoot:${JSON.stringify(root)}}})});
const service=t.createSessionService({repositories,sessions,jobs,bus,audit,jobRunner:runner,projectRoot:${JSON.stringify(root)},createEngine:()=>{throw Error('resume must restore persisted provider')}});
const result=await service.resumeRun({runId:${JSON.stringify(runId)}});await runner.stop();process.send({result});`;
}

describe('queued resume across independent OS processes', () => {
  it.each(['workflow', 'goal'] as const)('%s two resumers reuse the original Job and execute once', async mode => {
    const f = await setup(mode, true);
    const { runId, jobId } = f.admitted;
    await f.service.requestPause({ runId });
    const script = resumeScript(f.root, runId);
    const results = await parallelDatabaseProcesses(f.filename, [script, script]);
    expect(results).toHaveLength(2);
    for (const result of results) expect(result).toMatchObject({ outcome: 'enqueued', runId, jobId });
    expect(f.db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('running');
    f.runner.start();
    await waitFor(async () => (await f.jobs.get(jobId))?.status === 'done');
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('passed');
    expect(f.roleCount()).toBe(1);
  }, 20000);

  it('a separate process resumes the original Run after the paused admission has drained', async () => {
    const f = await setup('goal', true);
    const { runId, jobId } = f.admitted;
    await f.service.requestPause({ runId });
    f.runner.start();
    await waitFor(async () => (await f.jobs.get(jobId))?.status === 'done');
    expect(f.roleCount()).toBe(0);
    const [resumed] = await parallelDatabaseProcesses(f.filename, [resumeScript(f.root, runId)]);
    expect(resumed).toMatchObject({ outcome: 'enqueued', runId });
    expect(resumed.jobId).not.toBe(jobId);
    await waitFor(async () => (await f.jobs.get(resumed.jobId))?.status === 'done');
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe('passed');
    expect(f.roleCount()).toBe(1);
    expect(f.db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 2 });
  }, 20000);
});
