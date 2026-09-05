import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAuditLogger,
  createJobRepository,
  createMockAgentAdapter,
  createRepositories,
  createSessionEventStore,
  createWorkflowEngine,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const release of cleanup.splice(0).reverse()) release();
});

const blockedStates = ['pending', 'recovery_required'] as const;
const old = '2000-01-01T00:00:00.000Z';
const later = '2001-01-01T00:00:00.000Z';
const cutoff = '2026-01-01T00:00:00.000Z';
const domainTables = [
  'workflow_instances', 'phases', 'nodes', 'audit_events', 'role_runs',
  'artifacts', 'gate_results', 'worktree_leases', 'sessions', 'session_events', 'jobs',
] as const;

async function fixture(filesState: typeof blockedStates[number]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-readiness-'));
  cleanup.push(() => rmSync(repoPath, { recursive: true, force: true }));
  const db = openTekonDatabase({ filename: ':memory:' });
  cleanup.push(() => { db.close(); });
  migrateDatabase(db);
  const queue = createWriteQueue();
  const repositories = createRepositories(db, queue);
  const sessions = createSessionEventStore(db, queue);
  const jobs = createJobRepository(db, queue);
  const audit = createAuditLogger({ repositories });
  const adapter = createMockAgentAdapter();
  const runAgent = vi.spyOn(adapter, 'runAgent');
  const engine = createWorkflowEngine({
    repoPath, dataDir: '.tekon', repositories, audit, adapter,
    agentProvider: 'mock', agentConfigSummary: { provider: 'mock' },
  });
  // Use the real pure builder so the guard cannot appear to work merely
  // because an invalid plan would fail later for an unrelated reason.
  const prepared = engine.buildPreparedRun({
    requestId: 'readiness-request-01', demandText: '目录未就绪时禁止执行',
    mode: 'template', templateName: 'goal', kind: 'goal',
  });
  const initialJobId = 'job_initial_admission';
  const sessionId = 'session_admission';
  writeFileSync(join(repoPath, '.tekon'), '文件故障注入：阻止运行目录创建');
  await repositories.admissionStore.admitRun({ ...prepared, sessionData: {
    sessionId, workspaceRoot: repoPath, profile: 'human-web',
    jobId: initialJobId, jobKind: 'goal-run',
  } });
  db.prepare('update run_admissions set files_state = ? where request_id = ?').run(filesState, prepared.requestId);
  db.prepare('update jobs set created_at = ? where id = ?').run(old, initialJobId);

  const domainSnapshot = () => Object.fromEntries(domainTables.map((table) => [table,
    db.prepare(`select * from ${table} order by rowid`).all(),
  ]));
  const runJobs = () => db.prepare(`select j.* from jobs j join sessions s on s.id = j.session_id
    where s.run_id = ? order by j.id`).all(prepared.runId);
  const restoreFiles = async () => {
    rmSync(join(repoPath, '.tekon'));
    return repositories.admissionStore.recoverAdmissionFiles(prepared.requestId);
  };
  return { repoPath, db, repositories, sessions, jobs, engine, runAgent, prepared,
    initialJobId, sessionId, domainSnapshot, runJobs, restoreFiles };
}

describe('admission 文件就绪是实际认领和执行前置条件', () => {
  it.each(blockedStates)('%s：初始及额外Job都跳过认领和stale清理，恢复后认领原始Job', async (filesState) => {
    const f = await fixture(filesState);
    const workspace = await f.sessions.getOrCreateDefaultWorkspace(f.repoPath);
    const extraSession = await f.sessions.createSession({ workspaceId: workspace.id,
      title: '同Run的另一个Session', profile: 'human-web', runId: f.prepared.runId });
    for (const [id, sessionId, kind, status] of [
      ['job_extra_resume', f.sessionId, 'workflow-resume', 'queued'],
      ['job_extra_automation', extraSession.id, 'readiness-evaluate', 'queued'],
      ['job_stale_paused', extraSession.id, 'workflow-resume', 'paused'],
    ] as const) {
      await f.jobs.enqueue({ id, sessionId, kind, status, owner: null,
        lease: status === 'paused' ? later : null, abortState: 'none', checkpoint: null,
        createdAt: later, updatedAt: later });
    }

    // A real legacy run is the positive control for both SQL operations:
    // claimNext must make progress elsewhere, and stale cleanup must work there.
    const legacyRunId = 'legacy_ready_run';
    await f.repositories.createWorkflowInstance({ id: legacyRunId,
      projectId: f.prepared.projectId, demandId: f.prepared.demandId,
      status: 'paused', createdAt: later, updatedAt: later });
    const legacySession = await f.sessions.createSession({ workspaceId: workspace.id,
      title: '无admission的历史Run', profile: 'human-web', runId: legacyRunId });
    for (const status of ['queued', 'paused'] as const) {
      await f.jobs.enqueue({ id: `job_legacy_${status}`, sessionId: legacySession.id,
        kind: 'workflow-resume', status, owner: null, lease: status === 'paused' ? later : null,
        abortState: 'none', checkpoint: null, createdAt: later, updatedAt: later });
    }
    const protectedJobs = f.runJobs();
    expect(protectedJobs).toHaveLength(4);
    expect(await f.jobs.claimNext('readiness-worker')).toMatchObject({ id: 'job_legacy_queued', status: 'running' });
    expect(await f.jobs.claimNext('readiness-worker')).toBeNull();
    expect(await f.jobs.cancelStaleActiveJobs(f.prepared.runId, undefined, cutoff)).toBe(0);
    expect(await f.jobs.cancelStaleActiveJobs(legacyRunId, undefined, cutoff)).toBe(1);
    expect(f.runJobs()).toEqual(protectedJobs);

    const recovered = await f.restoreFiles();
    expect(recovered).toMatchObject({ runId: f.prepared.runId, jobId: f.initialJobId, filesState: 'ready' });
    expect(f.runJobs()).toEqual(protectedJobs);
    expect(await f.jobs.claimNext('recovery-worker')).toMatchObject({
      id: f.initialJobId, sessionId: f.sessionId, status: 'running', owner: 'recovery-worker',
    });
    expect(f.runJobs()).toHaveLength(4);
  });

  it.each(blockedStates.flatMap((filesState) =>
    (['executePreparedRun', 'resumeRun'] as const).map((method) => ({ filesState, method })),
  ))('$filesState：直接$method在任何状态/Audit/Role副作用前拒绝', async ({ filesState, method }) => {
    const f = await fixture(filesState);
    await f.repositories.updateWorkflowInstanceStatus(f.prepared.runId, 'paused');
    const before = f.domainSnapshot();
    const admissionBefore = await f.repositories.admissionStore.getAdmission(f.prepared.requestId);
    const filesBefore = readdirSync(f.repoPath);
    await expect(f.engine[method](f.prepared.runId)).rejects.toThrow('ADMISSION_RECOVERY_REQUIRED');
    expect(f.runAgent).not.toHaveBeenCalled();
    expect(f.domainSnapshot()).toEqual(before);
    expect(await f.repositories.admissionStore.getAdmission(f.prepared.requestId)).toEqual(admissionBefore);
    expect(readdirSync(f.repoPath)).toEqual(filesBefore);

    // Only readiness changes. The same real plan and entrypoint must now
    // execute successfully, proving the negative test reached a useful gate.
    await f.restoreFiles();
    await f.engine[method](f.prepared.runId);
    expect(f.runAgent).toHaveBeenCalledTimes(1);
    expect(await f.repositories.getWorkflowInstance(f.prepared.runId)).toMatchObject({ status: 'passed' });
  });

  it.each(blockedStates)('%s：目录恢复不复活已取消的Workflow、Session和初始Job', async (filesState) => {
    const f = await fixture(filesState);
    await f.repositories.updateWorkflowInstanceStatus(f.prepared.runId, 'cancelled');
    await f.sessions.updateSessionStatus(f.sessionId, 'cancelled');
    await f.jobs.updateJob(f.initialJobId, { status: 'cancelled', abortState: 'stopped' });
    const cancelled = f.domainSnapshot();
    const recovered = await f.restoreFiles();
    expect(recovered).toMatchObject({ runId: f.prepared.runId, sessionId: f.sessionId,
      jobId: f.initialJobId, filesState: 'ready' });
    expect(f.domainSnapshot()).toEqual(cancelled);
    expect(await f.jobs.claimNext('must-not-revive')).toBeNull();
    expect(f.runAgent).not.toHaveBeenCalled();
  });
});
