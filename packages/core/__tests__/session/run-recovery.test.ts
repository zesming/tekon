import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditLogger, createJobRepository, createJobRunner, createRepositories,
  createSessionEventBus, createSessionEventStore, createSessionService,
  createSubprocessRegistry, createWriteQueue, migrateDatabase, openTekonDatabase,
} from '../../src/index.js';

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const waitFor = async (predicate: () => Promise<boolean>, timeout = 3000) => {
  const end = Date.now() + timeout;
  while (!await predicate()) {
    if (Date.now() > end) throw new Error('condition timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

async function setup(filename = ':memory:') {
  const root = mkdtempSync(join(tmpdir(), 'tekon-run-recovery-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const db = openTekonDatabase({ filename });
  cleanup.push(() => db.close());
  migrateDatabase(db);
  const queue = createWriteQueue();
  const repositories = createRepositories(db, queue);
  const sessions = createSessionEventStore(db, queue);
  const jobs = createJobRepository(db, queue);
  const bus = createSessionEventBus();
  const audit = createAuditLogger({ repositories });
  const execute = vi.fn(async () => ({ status: 'done' as const }));
  const runner = createJobRunner({ jobs, sessions, bus, registry: createSubprocessRegistry(),
    executor: { execute }, pollIntervalMs: 5, leaseTtlMs: 60, heartbeatMs: 15 });
  cleanup.push(() => runner.stop());
  const service = createSessionService({ repositories, sessions, jobs, bus, audit,
    jobRunner: runner, projectRoot: root, createEngine: () => { throw new Error('not used'); } });
  const now = new Date().toISOString();
  await repositories.createProject({ id: 'project', name: 'Recovery', repoPath: root, createdAt: now });
  await repositories.createDemand({ id: 'demand', title: 'Recovery', body: 'Recovery', createdAt: now });
  const workspace = await sessions.getOrCreateDefaultWorkspace(root);
  async function seed(id = 'run', status = 'running') {
    await repositories.createWorkflowInstance({ id, projectId: 'project', demandId: 'demand',
      status: status as 'running', createdAt: now, updatedAt: now });
    const session = await sessions.createSession({ workspaceId: workspace.id, runId: id, title: null, profile: 'test' });
    const job = await runner.enqueue({ sessionId: session.id, kind: 'workflow-run' });
    return { session, job };
  }
  return { db, repositories, sessions, jobs, bus, runner, service, seed, execute, audit, now };
}

describe('R26 durable recovery contract', () => {
  it('publishes a durable status event after stale recovery for already connected observers', async () => {
    const f = await setup(); const { session, job } = await f.seed();
    await f.jobs.updateJob(job.id, { status: 'running', owner: 'dead', lease: '2000-01-01T00:00:00.000Z', exitEvidence: null });
    const observed: unknown[] = [];
    f.bus.subscribeAll(event => {
      if (event.type === 'job/status') observed.push({ payload: event.payload,
        run: f.db.prepare("select status from workflow_instances where id='run'").get() });
    });
    expect(await f.runner.recoverStale()).toBe(1);
    expect(observed).toContainEqual({ payload: { jobId: job.id, kind: job.kind, status: 'interrupted' }, run: { status: 'interrupted' } });
    expect((await f.sessions.listEventsSince(session.id, 0)).filter(e => e.type === 'job/status')).toHaveLength(1);
    expect(await f.runner.recoverStale()).toBe(0);
    expect(observed).toHaveLength(1);
  });

  it('does not rewrite activity timestamps when cancelled observation is already complete', async () => {
    const f = await setup(); const { session } = await f.seed();
    await f.service.requestCancel({ runId: 'run' });
    const historical = '2020-01-01T00:00:00.000Z';
    f.db.prepare('update sessions set updated_at=? where id=?').run(historical, session.id);
    const events = await f.sessions.listEventsSince(session.id, 0);
    await f.service.requestCancel({ runId: 'run' });
    await f.sessions.reconcileCancelledRun('run');
    expect((await f.sessions.getSession(session.id))?.updatedAt).toBe(historical);
    expect(await f.sessions.listEventsSince(session.id, 0)).toEqual(events);
  });
  it('keeps legacy exit evidence unknown when migrating an old stopped Job', async () => {
    const f=await setup(); const {job}=await f.seed('run','cancelled');
    await f.jobs.updateJob(job.id,{status:'cancelled',abortState:'stopped'});
    f.db.exec('alter table jobs drop column exit_evidence');
    migrateDatabase(f.db);
    expect((await f.sessions.getRunRecovery('run')).cancelRecovery?.exitStatus).toBe('unconfirmed');
    expect((await f.jobs.get(job.id))?.exitEvidence).toBeNull();
  });

  it('advances stale-recovery pages past per-row failures and retries them after wrap', async () => {
    const f=await setup();
    for(let i=0;i<105;i++) {
      const {job}=await f.seed(`run-${i}`);
      f.db.prepare("update jobs set id=?,status='running',owner='dead',lease='2000-01-01T00:00:00.000Z',exit_evidence=null where id=?")
        .run(`job-${String(i).padStart(3,'0')}`,job.id);
    }
    f.db.exec("create trigger first_stale_page before update on jobs when OLD.id<'job-100' and NEW.status='interrupted' begin select raise(abort,'row unavailable'); end");
    f.runner.start();
    await waitFor(async ()=>(await f.jobs.get('job-104'))?.status==='interrupted');
    expect((await f.jobs.get('job-000'))?.status).toBe('running');
    expect(f.execute).not.toHaveBeenCalled();
    f.db.exec('drop trigger first_stale_page');
    await waitFor(async ()=>(await f.jobs.get('job-000'))?.status==='interrupted');
  });

  it('does not open a new scan or claim after stop begins during an in-flight cancellation page', async () => {
    const f=await setup(); await f.seed('run','cancelled');
    let release!:()=>void; let entered=false;
    const barrier=new Promise<void>(resolve=>{release=resolve;});
    const list=f.sessions.listCancelledRunIds.bind(f.sessions);
    const scan=vi.spyOn(f.sessions,'listCancelledRunIds').mockImplementation(async (...args)=>{entered=true;await barrier;return list(...args);});
    const claim=vi.spyOn(f.jobs,'claimNext');
    f.runner.start(); await waitFor(async ()=>entered);
    const stopped=f.runner.stop(); release(); await stopped;
    expect(scan).toHaveBeenCalledTimes(1); expect(claim).not.toHaveBeenCalled();
  });
  it('does not leak the completed executor write scope into independent event subscribers', async () => {
    const f = await setup(); const { session } = await f.seed();
    let result: unknown;
    f.bus.subscribeAll(event => {
      if (event.type !== 'workflow/finished') return;
      setTimeout(() => { void f.runner.enqueue({ sessionId: session.id, kind: 'readiness-evaluate' }).then(job => { result=job; },error=>{result=error;}); },30);
    });
    f.execute.mockImplementationOnce(async () => {
      f.bus.publish(await f.sessions.appendEvent({sessionId:session.id,type:'workflow/finished'}));
      return {status:'done'};
    });
    f.runner.start();
    await waitFor(async ()=>Boolean(result));
    expect(result).not.toBeInstanceOf(Error);
    expect(result).toMatchObject({kind:'readiness-evaluate'});
  });
  it('advances beyond a persistently failing first cancellation page and wraps back to repair it', async () => {
    const f = await setup();
    const seeded = [];
    for (let i=0;i<105;i++) seeded.push(await f.seed(`run-${String(i).padStart(3,'0')}`, 'cancelled'));
    f.db.exec("create trigger first_page_failure before update on jobs when NEW.session_id in (select id from sessions where run_id<'run-100') begin select raise(abort,'first page unavailable'); end");
    f.runner.start();
    await waitFor(async ()=>(await f.sessions.getSession(seeded[104]!.session.id))?.status==='cancelled');
    expect((await f.sessions.getSession(seeded[0]!.session.id))?.status).toBe('active');
    f.db.exec('drop trigger first_page_failure');
    await waitFor(async ()=>(await f.sessions.getSession(seeded[0]!.session.id))?.status==='cancelled');
    expect((await f.sessions.listEventsSince(seeded[0]!.session.id,0)).filter(e=>e.type==='agent/cancelled')).toHaveLength(1);
  });

  it('rolls back confirmation audit and old-node handoff when enqueue fails, then resumes unfinished Agent in one admission', async () => {
    const f = await setup(); const { job } = await f.seed('run','interrupted');
    await f.jobs.updateJob(job.id,{status:'interrupted',exitEvidence:null});
    f.db.prepare("insert into nodes(id,run_id,role,status,gates,dependencies,created_at,updated_at) values('node','run','rd','running','[]','[]',?,?)").run(f.now,f.now);
    f.db.prepare("insert into role_runs(id,run_id,node_id,role,status,started_at) values('role','run','node','rd','running',?)").run(f.now);
    f.db.exec("create trigger reject_resume before insert on jobs when NEW.kind='workflow-resume' begin select raise(abort,'enqueue failed'); end");
    await expect(f.service.resumeRun({runId:'run',confirmStopped:true,previousJobId:job.id})).rejects.toThrow('enqueue failed');
    expect((await f.repositories.getNode('node'))?.status).toBe('running');
    expect(await f.repositories.listAuditEvents('run')).toHaveLength(0);
    f.db.exec('drop trigger reject_resume');
    const result=await f.service.resumeRun({runId:'run',confirmStopped:true,previousJobId:job.id});
    expect(result.outcome).toBe('enqueued');
    expect((await f.repositories.getNode('node'))?.status).toBe('interrupted');
    expect((await f.repositories.getLatestRoleRunForNode('run','node'))?.status).toBe('interrupted');
  });

  it('uses monotonic execution generations even with the same clock and rejects a prior confirmation', async () => {
    const f=await setup(); const {job,session}=await f.seed('run','interrupted');
    await f.jobs.updateJob(job.id,{status:'interrupted',exitEvidence:null});
    const before=await f.jobs.get(job.id);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(before!.createdAt));
    try {
      const result=await f.runner.enqueueIfNoActiveByRunId({runId:'run',sessionId:session.id,kind:'workflow-resume',confirmStopped:true,previousJobId:job.id});
      expect(result.outcome).toBe('enqueued');
      if(result.outcome!=='enqueued') throw Error('not enqueued');
      expect(result.job.createdAt).toBe(new Date(Date.parse(before!.createdAt) + 1).toISOString());
      await f.jobs.updateJob(result.job.id,{status:'interrupted',exitEvidence:null});
      expect(await f.service.resumeRun({runId:'run',confirmStopped:true,previousJobId:job.id})).toMatchObject({outcome:'stale-confirmation',previousJobId:result.job.id});
    } finally { vi.useRealTimers(); }
  });
  it('fences an old executor repository write even before its next owner poll', async () => {
    const f = await setup(); const { job } = await f.seed();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let lateError: unknown;
    f.execute.mockImplementationOnce(async () => {
      await pending;
      try { await f.repositories.updateWorkflowInstanceStatus('run', 'passed', null); }
      catch (error) { lateError = error; }
      return { status: 'done' };
    });
    f.runner.start();
    await waitFor(async () => f.execute.mock.calls.length === 1);
    await f.jobs.updateJob(job.id, { lease: '2000-01-01T00:00:00.000Z' });
    await f.runner.recoverStale();
    release();
    await waitFor(async () => Boolean(lateError) || (await f.repositories.getWorkflowInstance('run'))?.status === 'passed');
    expect(lateError).toBeInstanceOf(Error);
    expect((await f.repositories.getWorkflowInstance('run'))?.status).toBe('interrupted');
  });
  it('rolls back cancellation observation as one transaction and repairs it on retry', async () => {
    const f = await setup(); const { session, job } = await f.seed();
    f.db.exec("create trigger fail_cancel before insert on session_events when NEW.type='agent/cancelled' begin select raise(abort, 'observation failed'); end");
    await expect(f.service.requestCancel({ runId: 'run' })).rejects.toThrow('observation failed');
    expect((await f.jobs.get(job.id))?.status).toBe('cancelled');
    expect((await f.sessions.getSession(session.id))?.status).toBe('active');
    expect((await f.sessions.listEventsSince(session.id, 0)).filter(e => e.type.startsWith('agent/cancel'))).toHaveLength(0);
    f.db.exec('drop trigger fail_cancel');
    await f.service.requestCancel({ runId: 'run' });
    await f.service.requestCancel({ runId: 'run' });
    expect((await f.sessions.getSession(session.id))?.status).toBe('cancelled');
    expect((await f.sessions.listEventsSince(session.id, 0)).filter(e => e.type.startsWith('agent/cancel')).map(e => e.type))
      .toEqual(['agent/cancel-requested', 'agent/cancelled']);
  });

  it('preserves an existing partial event and only publishes committed new events', async () => {
    const f = await setup(); const { session } = await f.seed();
    const existing = await f.sessions.appendEvent({ sessionId: session.id, type: 'agent/cancel-requested', payload: { runId: 'run', original: true } });
    const publish = vi.spyOn(f.bus, 'publish');
    await f.service.requestCancel({ runId: 'run' });
    const events = await f.sessions.listEventsSince(session.id, 0);
    expect(events[0]).toEqual(existing);
    expect(events.filter(e => e.type === 'agent/cancel-requested')).toHaveLength(1);
    expect(publish.mock.calls.map(([e]) => e.type).filter(t => t.startsWith('agent/cancel'))).toEqual(['agent/cancelled']);
  });

  it('reports historical stopped and old queued rows as unconfirmed, preserving new never-started evidence', async () => {
    const f = await setup(); const { job } = await f.seed();
    await f.service.requestCancel({ runId: 'run' });
    expect((await f.sessions.getRunRecovery('run')).cancelRecovery?.exitStatus).toBe('confirmed');
    f.db.prepare('update jobs set exit_evidence=null where id=?').run(job.id);
    expect((await f.sessions.getRunRecovery('run')).cancelRecovery?.exitStatus).toBe('unconfirmed');
    const old = await f.seed('old');
    f.db.prepare('update jobs set exit_evidence=null where id=?').run(old.job.id);
    await f.service.requestCancel({ runId: 'old' });
    expect((await f.sessions.getRunRecovery('old')).cancelRecovery?.exitStatus).toBe('unconfirmed');
  });

  it('clears evidence on claim and periodically interrupts a lease that was fresh at restart without executing it', async () => {
    const f = await setup(); const { job, session } = await f.seed();
    await f.jobs.claimNext('dead-worker');
    expect((await f.jobs.get(job.id))?.exitEvidence).toBeNull();
    f.runner.start();
    await waitFor(async () => (await f.jobs.get(job.id))?.status === 'interrupted');
    expect(f.execute).not.toHaveBeenCalled();
    expect((await f.repositories.getWorkflowInstance('run'))?.status).toBe('interrupted');
    expect((await f.sessions.getSession(session.id))?.status).toBe('awaiting-input');
    expect((await f.jobs.get(job.id))?.exitEvidence).toBeNull();
    await expect(f.runner.requestCancel(job.id)).resolves.toBeUndefined();
  });

  it('periodically redelivers cancellation and repairs observation after the request client disconnects', async () => {
    const f = await setup(); const { job, session } = await f.seed();
    await f.jobs.claimNext('foreign');
    vi.spyOn(f.runner, 'requestCancel').mockRejectedValueOnce(new Error('client delivery failed'));
    await expect(f.service.requestCancel({ runId: 'run' })).rejects.toThrow('client delivery failed');
    f.runner.start();
    await waitFor(async () => (await f.sessions.getSession(session.id))?.status === 'cancelled');
    expect(['cancelling', 'cancelled']).toContain((await f.jobs.get(job.id))?.status);
    expect((await f.sessions.listEventsSince(session.id, 0)).filter(e => e.type === 'agent/cancelled')).toHaveLength(1);
  });

  it('requires matching explicit confirmation and audits it atomically without creating exit evidence', async () => {
    const f = await setup(); const { job, session } = await f.seed('run', 'interrupted');
    await f.jobs.updateJob(job.id, { status: 'interrupted', owner: null, exitEvidence: null });
    expect(await f.service.resumeRun({ runId: 'run' })).toMatchObject({ outcome: 'exit-unconfirmed', previousJobId: job.id });
    expect(await f.service.resumeRun({ runId: 'run', confirmStopped: true, previousJobId: 'wrong' })).toMatchObject({ outcome: 'stale-confirmation' });
    const result = await f.service.resumeRun({ runId: 'run', confirmStopped: true, previousJobId: job.id });
    expect(result).toMatchObject({ outcome: 'enqueued', runId: 'run', sessionId: session.id, previousJobId: job.id });
    expect((await f.jobs.get(job.id))?.exitEvidence).toBeNull();
    expect((await f.repositories.listAuditEvents('run')).filter(e => e.type === 'run.resume-exit-confirmed')).toHaveLength(1);
    expect(await f.audit.verify('run')).toEqual({ valid: true });
  });

  it('does not let a late automation job hide unknown execution exit', async () => {
    const f = await setup(); const { job, session } = await f.seed('run', 'interrupted');
    await f.jobs.updateJob(job.id, { status: 'interrupted', exitEvidence: null });
    await f.runner.enqueue({ sessionId: session.id, kind: 'readiness-evaluate' });
    expect((await f.sessions.getRunRecovery('run')).resumeRecovery).toEqual({ previousJobId: job.id, requiresConfirmation: true });
    expect(await f.service.resumeRun({ runId: 'run', afterApproval: true })).toMatchObject({ outcome: 'exit-unconfirmed' });
  });

  it('requires explicit null confirmation for an interrupted legacy run with no Job', async () => {
    const f = await setup(); const { job } = await f.seed('run', 'interrupted');
    f.db.prepare('delete from jobs where id=?').run(job.id);
    expect((await f.sessions.getRunRecovery('run')).resumeRecovery).toEqual({ previousJobId: null, requiresConfirmation: true });
    expect(await f.service.resumeRun({ runId: 'run', confirmStopped: true })).toMatchObject({ outcome: 'exit-unconfirmed' });
    expect(await f.service.resumeRun({ runId: 'run', confirmStopped: true, previousJobId: null })).toMatchObject({ outcome: 'enqueued', previousJobId: null });
  });

  it('checks the cancellation winner inside the enqueue transaction', async () => {
    const f = await setup(); const { job } = await f.seed('run', 'interrupted');
    await f.jobs.updateJob(job.id, { status: 'interrupted', exitEvidence: null });
    const enqueue = f.runner.enqueueIfNoActiveByRunId.bind(f.runner);
    vi.spyOn(f.runner, 'enqueueIfNoActiveByRunId').mockImplementation(async input => {
      await f.service.requestCancel({ runId: 'run' });
      return enqueue(input);
    });
    expect(await f.service.resumeRun({ runId: 'run', confirmStopped: true, previousJobId: job.id }))
      .toMatchObject({ outcome: 'terminal', status: 'cancelled' });
    expect(await f.jobs.findActiveByRunId('run')).toBeNull();
  });

  it('settles stale automation only, without interrupting its completed Run or Session', async () => {
    const f = await setup(); const { job, session } = await f.seed('run', 'passed');
    await f.jobs.updateJob(job.id, { status: 'done' });
    await f.sessions.updateSessionStatus(session.id, 'done');
    const automation = await f.runner.enqueue({ sessionId: session.id, kind: 'delivery-auto-prepare' });
    await f.jobs.claimNext('dead');
    await f.jobs.updateJob(automation.id, { lease: '2000-01-01T00:00:00.000Z' });
    await f.runner.recoverStale();
    expect((await f.jobs.get(automation.id))?.status).toBe('interrupted');
    expect((await f.sessions.getSession(session.id))?.status).toBe('done');
    expect((await f.repositories.getWorkflowInstance('run'))?.status).toBe('passed');
  });
});
