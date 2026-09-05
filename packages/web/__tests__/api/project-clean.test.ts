import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller, dispatchApiCall } from '../../src/server/api/root.js';

import {
  assertProjectDatabaseExists,
  createProjectContext,
} from '../../src/server/project-context.js';
import {
  createAuditLogger,
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
      .prepare(
        "select count(*) as count from audit_events where type = 'project.clean.suspended'",
      )
      .get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('project.clean suspended guard and audit', () => {
  it('preserves files and domain state while auditing active job and lease evidence', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const dbPath = join(fixture.projectRoot, '.tekon', 'tekon.sqlite');
    const seedDb = openTekonDatabase({ filename: dbPath });
    const seedQueue = createWriteQueue({ isClosed: () => seedDb.isClosed() });
    const seedRepositories = createRepositories(seedDb, seedQueue);
    const seedSessions = createSessionEventStore(seedDb, seedQueue);
    const seedJobs = createJobRepository(seedDb, seedQueue);
    cleanupTasks.unshift(() => {
      if (!seedDb.isClosed()) seedDb.close();
    });
    const workspace = await seedSessions.getOrCreateDefaultWorkspace(
      fixture.projectRoot,
    );
    const session = await seedSessions.createSession({
      workspaceId: workspace.id,
      title: 'Clean guard session',
      profile: 'human-web',
      runId: 'run_1',
    });
    await seedJobs.enqueue({
      id: 'job_clean_active',
      sessionId: session.id,
      kind: 'delivery-auto-prepare',
      status: 'queued',
      owner: null,
      lease: null,
      abortState: 'none',
      checkpoint: null,
      createdAt: '2026-09-04T00:00:00.000Z',
      updatedAt: '2026-09-04T00:00:00.000Z',
    });
    const worktreePath = join(
      fixture.projectRoot,
      '.tekon',
      'worktrees',
      'clean-guard-lease',
    );
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, 'preserved.txt'), 'keep this worktree');
    await seedRepositories.recordWorktreeLease({
      id: 'lease_clean_active',
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'reviewer',
      repoPath: fixture.projectRoot,
      worktreePath,
      branchName: 'tekon/clean-guard',
      baseHead: null,
      createdAt: '2026-09-04T00:00:00.000Z',
      releasedAt: null,
    });
    await seedRepositories.recordWorktreeLease({
      id: 'lease_clean_released',
      runId: 'run_1',
      nodeId: 'node_0',
      role: 'rd',
      repoPath: fixture.projectRoot,
      worktreePath: join(fixture.projectRoot, '.tekon', 'worktrees', 'released'),
      branchName: 'tekon/clean-guard-released',
      baseHead: null,
      createdAt: '2026-09-03T00:00:00.000Z',
      releasedAt: '2026-09-04T00:00:00.000Z',
    });
    const runDir = join(fixture.projectRoot, '.tekon', 'runs', 'run_1');
    const worktreesDir = join(fixture.projectRoot, '.tekon', 'worktrees');
    const beforeRunFiles = snapshotFiles(runDir);
    const beforeWorktreeFiles = snapshotFiles(worktreesDir);
    const beforeDatabase = snapshotDatabase(dbPath);
    const router = createProjectRouter({
      planPreviewSigner: createPlanPreviewSigner(),
      db: seedDb,
      repositories: seedRepositories,
      projectContext: createProjectContext({
        projectRoot: fixture.projectRoot,
      }),
      jobs: seedJobs,
      audit: createAuditLogger({ repositories: seedRepositories }),
      sessions: seedSessions,
      bus: {} as never,
      jobRunner: {} as never,
      registry: {} as never,
      sessionService: {} as never,
    });

    await expect(
      router.clean({
        runId: 'run_1',
        token: fixture.sessionToken,
        confirm: 'delete-run-dir',
      }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      message: expect.stringMatching(/CLEAN_SUSPENDED.*lifecycle-safe purge/),
    });

    expect(snapshotFiles(runDir)).toEqual(beforeRunFiles);
    expect(snapshotFiles(worktreesDir)).toEqual(beforeWorktreeFiles);
    expect(snapshotDatabase(dbPath)).toEqual(beforeDatabase);

    // Audit event must be appended
    const auditEvents = await seedRepositories.listAuditEvents('run_1');
    const suspendedEvent = auditEvents.find(
      (event) => event.type === 'project.clean.suspended',
    );
    expect(suspendedEvent).toBeDefined();
    expect(suspendedEvent?.payload).toEqual({
      reason: 'CLEAN_SUSPENDED',
      runStatus: 'paused',
      activeJobId: 'job_clean_active',
      unreleasedLeaseIds: ['lease_clean_active'],
    });
    expect(Object.keys(suspendedEvent?.payload ?? {}).sort()).toEqual([
      'activeJobId',
      'reason',
      'runStatus',
      'unreleasedLeaseIds',
    ]);
    expect(JSON.stringify(suspendedEvent?.payload)).not.toContain(
      fixture.sessionToken,
    );
    expect(JSON.stringify(suspendedEvent?.payload)).not.toContain(
      fixture.projectRoot,
    );
  });

  it('does not append audit when token is wrong', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.project.clean({
        runId: 'run_1',
        token: 'wrong-token',
        confirm: 'delete-run-dir',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const auditList = (await dispatchApiCall(api, 'audit.list', {
      runId: 'run_1',
    })) as { events: Array<any> };
    const suspendedEvent = auditList.events.find(
      (e: any) => e.type === 'project.clean.suspended',
    );
    expect(suspendedEvent).toBeUndefined();

    await api.close();
  });

  it('does not append audit when confirm is wrong', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      dispatchApiCall(api, 'project.clean', {
        runId: 'run_1',
        token: fixture.sessionToken,
        confirm: 'wrong-confirm' as any,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const auditList = (await dispatchApiCall(api, 'audit.list', {
      runId: 'run_1',
    })) as { events: Array<any> };
    const suspendedEvent = auditList.events.find(
      (e: any) => e.type === 'project.clean.suspended',
    );
    expect(suspendedEvent).toBeUndefined();

    await api.close();
  });

  it('does not append audit when runId is invalid format or out-of-scope', async () => {
    const fixture = await createWebFixtureProject({
      includeOutOfScopeProject: true,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      dispatchApiCall(api, 'project.clean', {
        runId: 'invalid/run/id',
        token: fixture.sessionToken,
        confirm: 'delete-run-dir',
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      dispatchApiCall(api, 'project.clean', {
        runId: 'run_escaped',
        token: fixture.sessionToken,
        confirm: 'delete-run-dir',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    expect(
      countCleanAudits(
        join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
      ),
    ).toBe(0);

    await api.close();
  });

  it('concurrent calls both fail with CONFLICT and neither deletes the directory', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const runDir = join(fixture.projectRoot, '.tekon', 'runs', 'run_1');
    const [res1, res2] = await Promise.allSettled([
      dispatchApiCall(api, 'project.clean', {
        runId: 'run_1',
        token: fixture.sessionToken,
        confirm: 'delete-run-dir',
      }),
      dispatchApiCall(api, 'project.clean', {
        runId: 'run_1',
        token: fixture.sessionToken,
        confirm: 'delete-run-dir',
      }),
    ]);

    for (const result of [res1, res2]) {
      expect(result.status).toBe('rejected');
      if (result.status === 'rejected') {
        expect(result.reason).toMatchObject({ code: 'CONFLICT' });
      }
    }
    expect(existsSync(runDir)).toBe(true);

    await api.close();
  });

  it('returns INTERNAL_ERROR with fixed sanitized message when audit append fails', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const projectContext = createProjectContext({
      projectRoot: fixture.projectRoot,
    });
    assertProjectDatabaseExists(projectContext);
    const db = openTekonDatabase({ filename: projectContext.dbPath });
    cleanupTasks.push(() => db.close());
    const writeQueue = createWriteQueue({ isClosed: () => db.isClosed() });
    const repositories = createRepositories(db, writeQueue);
    const jobs = createJobRepository(db, writeQueue);

    const failingAudit = {
      append: vi
        .fn()
        .mockRejectedValue(new Error('Disk write failure or db locked')),
      verify: vi.fn(),
    };

    const router = createProjectRouter({
      planPreviewSigner: createPlanPreviewSigner(),
      db,
      repositories,
      projectContext,
      jobs,
      audit: failingAudit as any,
      sessions: {} as any,
      bus: {} as any,
      jobRunner: {} as any,
      registry: {} as any,
      sessionService: {} as any,
    });

    await expect(
      router.clean({
        runId: 'run_1',
        token: fixture.sessionToken,
        confirm: 'delete-run-dir',
      }),
    ).rejects.toMatchObject({
      code: 'INTERNAL_ERROR',
      message: 'CLEAN_AUDIT_FAILED: unable to record suspended clean request',
    });

    const runDir = join(fixture.projectRoot, '.tekon', 'runs', 'run_1');
    expect(existsSync(runDir)).toBe(true);
  });
});
