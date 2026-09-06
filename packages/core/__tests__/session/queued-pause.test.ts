import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditLogger, createJobRepository, createJobRunner,
  createMockAgentAdapter, createRepositories, createSessionEventBus,
  createSessionEventStore, createSessionService, createSubprocessRegistry,
  createWorkflowEngine, createWorkflowJobExecutor, createWriteQueue,
  migrateDatabase, openTekonDatabase,
} from '../../src/index.js';

// Real SQLite, admission, runner and default workflow executor. The explicit
// mock Provider is deterministic; this is not a real-model lifecycle test.
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Job did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
async function setup(mode: 'workflow' | 'goal' = 'goal') {
  const root = mkdtempSync(join(tmpdir(), 'tekon-queued-pause-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Tekon test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'Queued pause regression\n');
  writeFileSync(join(root, '.gitignore'), '.tekon/\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  const db = openTekonDatabase({ filename: ':memory:' });
  cleanup.push(() => db.close());
  migrateDatabase(db);
  const queue = createWriteQueue();
  const repositories = createRepositories(db, queue);
  const audit = createAuditLogger({ repositories, db, writeQueue: queue });
  const sessions = createSessionEventStore(db, queue);
  const jobs = createJobRepository(db, queue);
  const bus = createSessionEventBus();
  const registry = createSubprocessRegistry();
  const executor = createWorkflowJobExecutor({ repositories, audit,
    projectContext: { projectRoot: root }, sessions, bus, registry });
  const runner = createJobRunner({ jobs, sessions, bus, registry, executor,
    pollIntervalMs: 5, heartbeatMs: 1000, stopSettleTimeoutMs: 100 });
  cleanup.push(() => runner.stop());
  const engine = createWorkflowEngine({ repoPath: root, dataDir: '.tekon',
    repositories, audit, adapter: createMockAgentAdapter(), agentProvider: 'mock' });
  const service = createSessionService({ repositories, audit, sessions, jobs,
    bus, jobRunner: runner, projectRoot: root, createEngine: () => engine });
  const admitted = await service.startRun({ demandText: 'Verify queued pause',
    mode, templateName: 'goal', engine: null });
  const roleCount = () => (db.prepare('select count(*) as n from role_runs where run_id=?')
    .get(admitted.runId) as { n: number }).n;
  return { db, repositories, sessions, jobs, runner, service, admitted, roleCount };
}

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
    vi.spyOn(f.jobs, 'get').mockImplementationOnce(async id => {
      const job = await get(id);
      f.db.prepare('update workflow_instances set status=? where id=?').run(status, runId);
      return job;
    });
    expect(await f.service.resumeRun({ runId })).toMatchObject({ outcome: 'terminal', status });
    expect((await f.repositories.getWorkflowInstance(runId))?.status).toBe(status);
    expect(f.roleCount()).toBe(0);
    expect(f.db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
  });
});
