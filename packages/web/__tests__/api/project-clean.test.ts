import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller, dispatchApiCall } from '../../src/server/api/root.js';

import {
  assertProjectDatabaseExists,
  createProjectContext,
} from '../../src/server/project-context.js';
import {
  createJobRepository,
  createRepositories,
  createSessionEventStore,
  createWriteQueue,
  openTekonDatabase,
} from '@tekon/core';
import { createProjectRouter } from '../../src/server/api/routers/project.js';
import { createPlanPreviewSigner } from '../../src/server/api/plan-preview.js';

const cleanupTasks: Array<() => void> = [];
const SNAPSHOT_TABLES = [
  'workflow_instances',
  'artifacts',
  'gate_results',
  'delivery_pull_requests',
  'sessions',
  'jobs',
  'worktree_leases',
] as const;

function snapshotFiles(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  if (!existsSync(root)) return snapshot;
  const visit = (path: string) => {
    for (const entry of readdirSync(path)) {
      const entryPath = join(path, entry);
      if (statSync(entryPath).isDirectory()) visit(entryPath);
      else snapshot[relative(root, entryPath)] = readFileSync(entryPath).toString('base64');
    }
  };
  visit(root);
  return snapshot;
}

function snapshotDatabase(dbPath: string): Record<string, unknown[]> {
  const db = openTekonDatabase({ filename: dbPath });
  try {
    return Object.fromEntries(
      SNAPSHOT_TABLES.map((table) => [
        table,
        db.prepare(`select * from ${table} order by rowid`).all(),
      ]),
    );
  } finally {
    db.close();
  }
}

function countCleanAudits(dbPath: string): number {
  const db = openTekonDatabase({ filename: dbPath });
  try {
    const row = db
      .prepare("select count(*) as count from audit_events where type = 'run.cleanup'")
      .get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function setRunStatus(dbPath: string, runId: string, status: string): void {
  const db = openTekonDatabase({ filename: dbPath });
  try {
    db.prepare('update workflow_instances set status = ? where id = ?').run(status, runId);
  } finally {
    db.close();
  }
}

function nodeBranches(repo: string): string[] {
  return execFileSync('git', ['for-each-ref', '--format=%(refname:short)', 'refs/heads/tekon/'], {
    cwd: repo, encoding: 'utf8',
  }).split('\n').filter(Boolean);
}

async function fixtureWithApi() {
  const fixture = await createWebFixtureProject();
  cleanupTasks.push(fixture.cleanup);
  const api = await createApiCaller({ projectRoot: fixture.projectRoot });
  const dbPath = join(fixture.projectRoot, '.tekon', 'tekon.sqlite');
  const clean = (input: Record<string, unknown> = {}) =>
    dispatchApiCall(api, 'project.clean', {
      runId: 'run_1',
      token: fixture.sessionToken,
      confirm: 'clean-terminal-runs',
      ...input,
    });
  return { fixture, api, dbPath, clean };
}

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('project.clean', () => {
  it('refuses a run that can still resume and changes nothing', async () => {
    const { fixture, api, dbPath, clean } = await fixtureWithApi();
    const runDir = join(fixture.projectRoot, '.tekon', 'runs', 'run_1');
    const worktreesDir = join(fixture.projectRoot, '.tekon', 'worktrees');
    const before = {
      runFiles: snapshotFiles(runDir),
      worktreeFiles: snapshotFiles(worktreesDir),
      database: snapshotDatabase(dbPath),
      branches: nodeBranches(fixture.projectRoot),
    };
    expect(before.branches).toHaveLength(1);

    await expect(clean()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('运行 run_1 的状态是 paused'),
    });
    await expect(clean({ dryRun: true })).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(snapshotFiles(runDir)).toEqual(before.runFiles);
    expect(snapshotFiles(worktreesDir)).toEqual(before.worktreeFiles);
    expect(snapshotDatabase(dbPath)).toEqual(before.database);
    expect(nodeBranches(fixture.projectRoot)).toEqual(before.branches);
    expect(countCleanAudits(dbPath)).toBe(0);
    await api.close();
  });

  it('previews, then removes a finished run’s worktree and node branch', async () => {
    const { fixture, api, dbPath, clean } = await fixtureWithApi();
    setRunStatus(dbPath, 'run_1', 'cancelled');
    const [lease] = await createRepositories(openTracked(dbPath)).listWorktreeLeases('run_1');
    expect(existsSync(lease!.worktreePath)).toBe(true);

    await expect(clean({ dryRun: true })).resolves.toEqual({
      runId: 'run_1', dryRun: true, worktrees: 1, branches: 1, missing: 0, failures: 0,
    });
    expect(existsSync(lease!.worktreePath)).toBe(true);
    expect(countCleanAudits(dbPath)).toBe(0);

    await expect(clean()).resolves.toEqual({
      runId: 'run_1', dryRun: false, worktrees: 1, branches: 1, missing: 0, failures: 0,
    });
    expect(existsSync(lease!.worktreePath)).toBe(false);
    expect(nodeBranches(fixture.projectRoot)).toEqual([]);
    expect(
      execFileSync('git', ['branch', '--list', 'tekon-delivery/run_1'], {
        cwd: fixture.projectRoot, encoding: 'utf8',
      }).trim(),
    ).not.toBe('');
    expect(existsSync(join(fixture.projectRoot, '.tekon', 'runs', 'run_1'))).toBe(true);
    expect(countCleanAudits(dbPath)).toBe(1);
    expect((snapshotDatabase(dbPath).workflow_instances as Array<{ id: string; status: string }>)
      .find((run) => run.id === 'run_1')?.status).toBe('cancelled');
    await api.close();
  });

  it('serializes concurrent cleans of the same run', async () => {
    const { api, dbPath, clean } = await fixtureWithApi();
    setRunStatus(dbPath, 'run_1', 'failed');
    const results = await Promise.all([clean(), clean()]) as Array<{ worktrees: number; failures: number }>;
    expect(results.map((result) => result.worktrees).sort()).toEqual([0, 1]);
    expect(results.every((result) => result.failures === 0)).toBe(true);
    await api.close();
  });

  it('refuses a finished run that still has an active job', async () => {
    const { fixture, api, dbPath, clean } = await fixtureWithApi();
    setRunStatus(dbPath, 'run_1', 'passed');
    const db = openTracked(dbPath);
    const queue = createWriteQueue({ isClosed: () => db.isClosed() });
    const sessions = createSessionEventStore(db, queue);
    const workspace = await sessions.getOrCreateDefaultWorkspace(fixture.projectRoot);
    const session = await sessions.createSession({
      workspaceId: workspace.id, title: null, profile: 'human-web', runId: 'run_1',
    });
    await createJobRepository(db, queue).enqueue({
      id: 'job_clean_active', sessionId: session.id, kind: 'delivery-auto-prepare',
      status: 'queued', owner: null, lease: null, abortState: 'none', checkpoint: null,
      createdAt: '2026-09-04T00:00:00.000Z', updatedAt: '2026-09-04T00:00:00.000Z',
    });

    await expect(clean()).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringContaining('job_clean_active'),
    });
    expect(nodeBranches(fixture.projectRoot)).toHaveLength(1);
    await api.close();
  });

  it('checks token, confirmation and run scope before doing anything', async () => {
    const fixture = await createWebFixtureProject({ includeOutOfScopeProject: true });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const dbPath = join(fixture.projectRoot, '.tekon', 'tekon.sqlite');
    setRunStatus(dbPath, 'run_1', 'cancelled');
    const input = { runId: 'run_1', token: fixture.sessionToken, confirm: 'clean-terminal-runs' };

    await expect(
      dispatchApiCall(api, 'project.clean', { ...input, token: 'wrong-token' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    // The old confirmation literal no longer authorizes anything.
    await expect(
      dispatchApiCall(api, 'project.clean', { ...input, confirm: 'delete-run-dir' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      dispatchApiCall(api, 'project.clean', { ...input, runId: 'invalid/run/id' }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      dispatchApiCall(api, 'project.clean', { ...input, runId: 'run_escaped' }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(nodeBranches(fixture.projectRoot)).toHaveLength(1);
    expect(countCleanAudits(dbPath)).toBe(0);
    await api.close();
  });

  it('returns a fixed INTERNAL_ERROR when the result cannot be audited', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const projectContext = createProjectContext({ projectRoot: fixture.projectRoot });
    assertProjectDatabaseExists(projectContext);
    setRunStatus(projectContext.dbPath, 'run_1', 'cancelled');
    const db = openTracked(projectContext.dbPath);
    const writeQueue = createWriteQueue({ isClosed: () => db.isClosed() });
    const repositories = createRepositories(db, writeQueue);
    const router = createProjectRouter({
      planPreviewSigner: createPlanPreviewSigner(),
      db,
      repositories,
      projectContext,
      jobs: createJobRepository(db, writeQueue),
      audit: {
        append: vi.fn().mockRejectedValue(new Error('Disk write failure or db locked')),
        verify: vi.fn(),
      } as never,
      sessions: {} as never,
      bus: {} as never,
      jobRunner: {} as never,
      registry: {} as never,
      sessionService: {} as never,
    });

    await expect(
      router.clean({ runId: 'run_1', token: fixture.sessionToken, confirm: 'clean-terminal-runs' }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'CLEAN_AUDIT_FAILED: unable to record the clean result',
    });
  });
});

function openTracked(dbPath: string) {
  const db = openTekonDatabase({ filename: dbPath });
  cleanupTasks.unshift(() => {
    if (!db.isClosed()) db.close();
  });
  return db;
}
