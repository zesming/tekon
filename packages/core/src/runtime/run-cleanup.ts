import { resolve } from 'node:path';

import type { AuditLogger } from '../audit/logger.js';
import type { TekonDatabase } from '../db/connection.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { WorktreeManager } from './worktree-manager.js';

/** Run statuses that can no longer resume, so their resources can go. */
export const CLEANABLE_RUN_STATUSES = ['passed', 'failed', 'cancelled'] as const;

export interface RunCleanupCandidate {
  runId: string;
  status: string;
  /** Worktree directories still held by a lease. */
  worktrees: string[];
  /** Node branches that still exist. */
  branches: string[];
}

export interface RunCleanupReport {
  runId: string;
  worktreesRemoved: number;
  worktreesMissing: number;
  branchesDeleted: number;
  branchesMissing: number;
  failures: Array<{ step: string; target: string; message: string }>;
}

export class RunCleanupError extends Error {
  constructor(
    readonly code: 'RUN_NOT_FOUND' | 'RUN_NOT_TERMINAL' | 'RUN_HAS_ACTIVE_JOB',
    message: string,
  ) {
    super(message);
    this.name = 'RunCleanupError';
  }
}

/** The clean ran but its result could not be written to the audit log. */
export class RunCleanupAuditError extends Error {
  constructor(readonly runId: string, cause: unknown) {
    super(`无法记录运行 ${runId} 的清理结果`, { cause });
    this.name = 'RunCleanupAuditError';
  }
}

export interface RunCleanup {
  /**
   * What a clean would remove. With a runId, the run must be cleanable and is
   * returned even when nothing is left; without one, every cleanable run that
   * still has something to remove.
   */
  plan(runId?: string): Promise<RunCleanupCandidate[]>;
  /** Cleans one finished run. Failures go to the audit log, never the run. */
  clean(runId: string): Promise<RunCleanupReport>;
}

export function createRunCleanup(deps: {
  db: TekonDatabase;
  repositories: TekonRepositories;
  audit: AuditLogger;
  worktreeManager: WorktreeManager;
  repoPath: string;
}): RunCleanup {
  const repoPath = resolve(deps.repoPath);
  // Cleans of the same run take turns within this process.
  const inFlight = new Map<string, Promise<unknown>>();

  function assertCleanable(runId: string): string {
    const run = deps.db
      .prepare('select status from workflow_instances where id = ?')
      .get(runId) as { status: string } | undefined;
    if (!run) throw new RunCleanupError('RUN_NOT_FOUND', `找不到运行 ${runId}`);
    if (!(CLEANABLE_RUN_STATUSES as readonly string[]).includes(run.status)) {
      throw new RunCleanupError(
        'RUN_NOT_TERMINAL',
        `运行 ${runId} 的状态是 ${run.status}，只能清理已完成、已失败或已取消的运行`,
      );
    }
    // Any kind counts, including delayed delivery and readiness automation.
    const active = deps.db
      .prepare(
        `select j.id from jobs j join sessions s on s.id = j.session_id
         where s.run_id = ? and j.status in ('queued', 'running', 'paused', 'cancelling')
         limit 1`,
      )
      .get(runId) as { id: string } | undefined;
    if (active) {
      throw new RunCleanupError(
        'RUN_HAS_ACTIVE_JOB',
        `运行 ${runId} 还有未结束的任务 ${active.id}，等它结束后再清理`,
      );
    }
    return run.status;
  }

  async function candidate(runId: string, status: string): Promise<RunCleanupCandidate> {
    const leases = await deps.repositories.listWorktreeLeases(runId);
    const existing = new Set(await deps.worktreeManager.listRunBranches(runId, repoPath));
    return {
      runId,
      status,
      worktrees: leases.filter((lease) => !lease.releasedAt).map((lease) => lease.worktreePath),
      branches: [...new Set(leases.map((lease) => lease.branchName))]
        .filter((name) => existing.has(name))
        .sort(),
    };
  }

  return {
    async plan(runId) {
      if (runId) return [await candidate(runId, assertCleanable(runId))];
      const placeholders = CLEANABLE_RUN_STATUSES.map(() => '?').join(', ');
      const runs = deps.db
        .prepare(
          `select distinct w.id, w.status from workflow_instances w
           join worktree_leases l on l.run_id = w.id
           where w.status in (${placeholders})
           order by w.created_at, w.id`,
        )
        .all(...CLEANABLE_RUN_STATUSES) as Array<{ id: string; status: string }>;
      const result: RunCleanupCandidate[] = [];
      for (const run of runs) {
        try {
          assertCleanable(run.id);
        } catch (error) {
          if (error instanceof RunCleanupError) continue;
          throw error;
        }
        const planned = await candidate(run.id, run.status);
        if (planned.worktrees.length > 0 || planned.branches.length > 0) result.push(planned);
      }
      return result;
    },

    async clean(runId) {
      const previous = inFlight.get(runId) ?? Promise.resolve();
      const task = previous.catch(() => undefined).then(() => cleanNow(runId));
      inFlight.set(runId, task);
      try {
        return await task;
      } finally {
        if (inFlight.get(runId) === task) inFlight.delete(runId);
      }
    },
  };

  async function cleanNow(runId: string): Promise<RunCleanupReport> {
    assertCleanable(runId);
    const result = await deps.worktreeManager.cleanupRun(runId, repoPath);
    const report: RunCleanupReport = {
      runId,
      worktreesRemoved: result.removedWorktrees.length,
      worktreesMissing: result.missingWorktrees.length,
      branchesDeleted: result.deletedBranches.length,
      branchesMissing: result.missingBranches.length,
      failures: result.failures,
    };
    try {
      await deps.audit.append({
        runId,
        type: 'run.cleanup',
        payload: {
          ...report,
          ...(result.missingWorktrees.length ? { missingWorktrees: result.missingWorktrees } : {}),
          ...(result.missingBranches.length ? { missingBranches: result.missingBranches } : {}),
        },
      });
    } catch (error) {
      throw new RunCleanupAuditError(runId, error);
    }
    return report;
  }
}
