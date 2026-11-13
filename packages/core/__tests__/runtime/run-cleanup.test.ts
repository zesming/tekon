import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createCommandGateway,
  createJobRepository,
  createRepositories,
  createRunCleanup,
  createSessionEventStore,
  createWorktreeManager,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  RunCleanupError,
} from '../../src/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { force: true, recursive: true });
});

function git(repoPath: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8', stdio: 'pipe' });
}

function branches(repoPath: string): string[] {
  return git(repoPath, 'for-each-ref', '--format=%(refname:short)', 'refs/heads/')
    .split('\n')
    .filter(Boolean)
    .sort();
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort();
}

type Gateway = ReturnType<typeof createCommandGateway>;

async function setup(options: { wrapGateway?: (gateway: Gateway) => Gateway } = {}) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-run-cleanup-'));
  tempDirs.push(repoPath);
  git(repoPath, 'init', '-b', 'main');
  git(repoPath, 'config', 'user.email', 'test@tekon.local');
  git(repoPath, 'config', 'user.name', 'Tekon Test');
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
  writeFileSync(join(repoPath, '.gitignore'), '.tekon/\n');
  git(repoPath, 'add', '.');
  git(repoPath, 'commit', '-m', 'fixture');

  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  const repositories = createRepositories(db, writeQueue);
  const audit = createAuditLogger({ repositories, db, writeQueue });
  const baseGateway = createCommandGateway();
  const manager = createWorktreeManager({
    repositories,
    gateway: options.wrapGateway ? options.wrapGateway(baseGateway) : baseGateway,
  });
  const cleanup = createRunCleanup({ db, repositories, audit, worktreeManager: manager, repoPath });
  await repositories.createDemand({
    id: 'demand_1', title: 'Cleanup', body: 'Cleanup.', createdAt: '2026-11-12T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1', name: 'fixture', repoPath, createdAt: '2026-11-12T00:00:00.000Z',
  });
  const createRun = async (id: string, status: string) => {
    await repositories.createWorkflowInstance({
      id, projectId: 'project_1', demandId: 'demand_1', status: status as never,
      createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
    });
  };
  const lease = (runId: string, nodeId: string) =>
    manager.createLease({ repoPath, runId, nodeId, role: 'rd', baseRef: 'HEAD' });
  return { repoPath, db, writeQueue, repositories, manager, cleanup, createRun, lease };
}

describe('run cleanup', () => {
  it('removes a finished run’s worktrees and node branches and keeps everything else', async () => {
    const f = await setup();
    await f.createRun('run_done', 'passed');
    const released = await f.lease('run_done', 'node_a');
    const open = await f.lease('run_done', 'node_b');
    await f.manager.releaseLease(released.id);
    await f.manager.ensureRunBranch({ repoPath: f.repoPath, runId: 'run_done', baseRef: 'HEAD' });
    const evidence = join(f.repoPath, '.tekon', 'runs', 'run_done', 'evidence.txt');
    mkdirSync(join(f.repoPath, '.tekon', 'runs', 'run_done'), { recursive: true });
    writeFileSync(evidence, 'kept');
    const stray = join(f.repoPath, '.tekon', 'worktrees', 'run_done', 'not-a-lease');
    mkdirSync(stray, { recursive: true });

    await expect(f.cleanup.plan()).resolves.toEqual([
      {
        runId: 'run_done',
        status: 'passed',
        worktrees: [open.worktreePath],
        branches: [released.branchName, open.branchName].sort(),
      },
    ]);

    const report = await f.cleanup.clean('run_done');
    expect(report).toMatchObject({
      runId: 'run_done',
      worktreesRemoved: 1,
      worktreesMissing: 0,
      branchesDeleted: 2,
      branchesMissing: 0,
      failures: [],
    });
    expect(existsSync(open.worktreePath)).toBe(false);
    expect((await f.repositories.getWorktreeLease(open.id))?.releasedAt).toBeTruthy();
    expect(branches(f.repoPath)).toEqual(['main', 'tekon-delivery/run_done']);
    expect(existsSync(evidence)).toBe(true);
    expect(existsSync(stray)).toBe(true);
    const events = await f.repositories.listAuditEvents('run_done');
    expect(events.at(-1)).toMatchObject({
      type: 'run.cleanup',
      payload: { worktreesRemoved: 1, branchesDeleted: 2, failures: [] },
    });
    // The run itself is untouched.
    expect((await f.repositories.getWorkflowInstance('run_done'))?.status).toBe('passed');

    // Nothing is left to do, and a second clean is harmless.
    await expect(f.cleanup.plan()).resolves.toEqual([]);
    await expect(f.cleanup.clean('run_done')).resolves.toMatchObject({
      worktreesRemoved: 0, branchesDeleted: 0, failures: [],
    });
  });

  it('refuses a run that is not finished or still has an active job, changing nothing', async () => {
    const f = await setup();
    await f.createRun('run_paused', 'paused');
    const paused = await f.lease('run_paused', 'node_a');
    await f.createRun('run_busy', 'cancelled');
    const busy = await f.lease('run_busy', 'node_a');
    const sessions = createSessionEventStore(f.db, f.writeQueue);
    const workspace = await sessions.getOrCreateDefaultWorkspace(f.repoPath);
    const session = await sessions.createSession({
      workspaceId: workspace.id, title: 'busy', profile: 'cli', runId: 'run_busy',
    });
    await createJobRepository(f.db, f.writeQueue).enqueue({
      id: 'job_busy', sessionId: session.id, kind: 'delivery-auto-prepare', status: 'queued',
      owner: null, lease: null, abortState: 'none', checkpoint: null,
      createdAt: '2026-11-12T00:00:00.000Z', updatedAt: '2026-11-12T00:00:00.000Z',
    });
    await expect(f.cleanup.clean('run_missing')).rejects.toMatchObject({ code: 'RUN_NOT_FOUND' });

    await expect(f.cleanup.clean('run_paused')).rejects.toMatchObject({ code: 'RUN_NOT_TERMINAL' });
    await expect(f.cleanup.plan('run_paused')).rejects.toBeInstanceOf(RunCleanupError);
    await expect(f.cleanup.clean('run_busy')).rejects.toMatchObject({ code: 'RUN_HAS_ACTIVE_JOB' });
    // Listing every run skips both instead of failing.
    await expect(f.cleanup.plan()).resolves.toEqual([]);
    expect(existsSync(paused.worktreePath)).toBe(true);
    expect(existsSync(busy.worktreePath)).toBe(true);
    expect(branches(f.repoPath)).toEqual(
      ['main', paused.branchName, busy.branchName].sort(),
    );
  });

  it('records what was already gone and never deletes a branch outside the run', async () => {
    const f = await setup();
    await f.createRun('run_gone', 'failed');
    const dirGone = await f.lease('run_gone', 'node_a');
    const branchGone = await f.lease('run_gone', 'node_b');
    const foreign = await f.lease('run_gone', 'node_c');
    rmSync(dirGone.worktreePath, { recursive: true, force: true });
    await f.manager.releaseLease(branchGone.id);
    git(f.repoPath, 'branch', '-D', branchGone.branchName);
    await f.manager.releaseLease(foreign.id);
    f.db.prepare('update worktree_leases set branch_name = ? where id = ?').run('main', foreign.id);

    const report = await f.cleanup.clean('run_gone');
    expect(report).toMatchObject({
      worktreesRemoved: 0,
      worktreesMissing: 1,
      branchesDeleted: 1,
      branchesMissing: 1,
      failures: [{ step: 'branch', target: 'main' }],
    });
    expect((await f.repositories.getWorktreeLease(dirGone.id))?.releasedAt).toBeTruthy();
    expect(branches(f.repoPath)).toEqual(['main', foreign.branchName].sort());
    const event = (await f.repositories.listAuditEvents('run_gone')).at(-1);
    expect(event?.payload).toMatchObject({
      missingWorktrees: [dirGone.worktreePath],
      missingBranches: [branchGone.branchName],
    });
    expect((await f.repositories.getWorkflowInstance('run_gone'))?.status).toBe('failed');
  });
  it('plans without writing anything into the runs’ evidence directories', async () => {
    const f = await setup();
    await f.createRun('run_done', 'passed');
    await f.lease('run_done', 'node_a');
    await f.createRun('run_old', 'failed');
    const old = await f.lease('run_old', 'node_a');
    await f.cleanup.clean('run_old');
    expect(existsSync(old.worktreePath)).toBe(false);
    const runs = join(f.repoPath, '.tekon', 'runs');
    const before = filesUnder(runs);

    await f.cleanup.plan();
    await f.cleanup.plan('run_done');
    await f.cleanup.plan('run_old');

    expect(filesUnder(runs)).toEqual(before);
  });

  it('keeps the branch of a worktree it could not remove and ignores leases of another repository', async () => {
    const f = await setup();
    await f.createRun('run_mixed', 'cancelled');
    const unmanaged = await f.lease('run_mixed', 'node_a');
    const elsewhere = await f.lease('run_mixed', 'node_b');
    const outside = join(f.repoPath, 'outside-worktree');
    f.db.prepare('update worktree_leases set worktree_path = ? where id = ?').run(outside, unmanaged.id);
    f.db.prepare('update worktree_leases set repo_path = ? where id = ?')
      .run(join(tmpdir(), 'tekon-moved-repo'), elsewhere.id);

    await expect(f.cleanup.plan('run_mixed')).resolves.toEqual([
      { runId: 'run_mixed', status: 'cancelled', worktrees: [outside], branches: [unmanaged.branchName] },
    ]);
    const report = await f.cleanup.clean('run_mixed');

    expect(report.failures).toEqual([
      expect.objectContaining({ step: 'worktree', target: outside }),
    ]);
    expect(report.branchesDeleted).toBe(0);
    expect(branches(f.repoPath)).toEqual(
      ['main', unmanaged.branchName, elsewhere.branchName].sort(),
    );
    expect(existsSync(elsewhere.worktreePath)).toBe(true);
    expect((await f.repositories.getWorktreeLease(elsewhere.id))?.releasedAt).toBeFalsy();
  });

  it('reports a branch listing it could not read instead of calling the branches gone', async () => {
    let failListing = false;
    const f = await setup({
      wrapGateway: (gateway) => ({
        ...gateway,
        run: (input) =>
          failListing && input.command.args[0] === 'for-each-ref'
            ? Promise.resolve({ status: 'rejected', reason: 'listing unavailable' })
            : gateway.run(input),
      }),
    });
    await f.createRun('run_list', 'passed');
    const lease = await f.lease('run_list', 'node_a');
    failListing = true;

    const report = await f.cleanup.clean('run_list');

    expect(report).toMatchObject({ worktreesRemoved: 1, branchesDeleted: 0, branchesMissing: 0 });
    expect(report.failures).toEqual([expect.objectContaining({ step: 'branch-list' })]);
    expect(branches(f.repoPath)).toContain(lease.branchName);
  });
});
