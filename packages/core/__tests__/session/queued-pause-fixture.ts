import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
export async function cleanupQueuedPause() {
  for (const close of cleanup.splice(0).reverse()) await close();
}
export async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('Job did not settle');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}
export async function setup(mode: 'workflow' | 'goal' = 'goal', persistent = false) {
  const root = mkdtempSync(join(tmpdir(), 'tekon-queued-pause-'));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '--initial-branch=main');
  git('config', 'user.name', 'Tekon test');
  git('config', 'user.email', 'test@example.invalid');
  writeFileSync(join(root, 'README.md'), 'Queued pause regression\n');
  writeFileSync(join(root, '.gitignore'), '.tekon/\n');
  git('add', '.'); git('commit', '-m', 'fixture');
  mkdirSync(join(root, '.tekon'), { recursive: true });
  const filename = persistent ? join(root, '.tekon', 'tekon.sqlite') : ':memory:';
  const db = openTekonDatabase({ filename });
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
  return { root, filename, db, repositories, sessions, jobs, runner, service, admitted, roleCount };
}
