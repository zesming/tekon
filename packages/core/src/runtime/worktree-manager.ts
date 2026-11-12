import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import type { Role } from '../types/domain.js';
import type { WorktreeLease } from '../types/config.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { CommandGateway } from './command-gateway.js';

export interface CreateLeaseInput {
  repoPath: string;
  runId: string;
  nodeId: string;
  role: Role;
  baseRef: string;
  allowDirtyBase?: boolean;
}

export interface WorktreeManager {
  ensureRunBranch(input: {
    repoPath: string;
    runId: string;
    baseRef: string;
  }): Promise<string>;
  createLease(input: CreateLeaseInput): Promise<WorktreeLease>;
  commitLeaseChanges(
    leaseId: string,
    input: { message: string },
  ): Promise<boolean>;
  inspectLeaseSourceChanges(leaseId: string): Promise<{
    changedPaths: string[];
    headChanged: boolean;
    baseHead?: string | null;
    currentHead: string;
  }>;
  listLeaseSourceChanges(leaseId: string): Promise<string[]>;
  getLeaseHead(leaseId: string): Promise<string>;
  promoteLeaseToRunBranch(input: {
    leaseId: string;
    branchName?: string;
  }): Promise<string>;
  releaseLease(leaseId: string): Promise<void>;
  pruneStaleLeases(repoPath: string): Promise<void>;
  listLeases(runId: string): Promise<WorktreeLease[]>;
  /**
   * Node branches (`tekon/<runId>/…`) of this run that still exist. A read
   * only query: it leaves no command output in the run's directory.
   */
  listRunBranches(runId: string, repoPath: string): Promise<string[]>;
  /**
   * Removes a finished run's leftover worktrees and node branches. Each step
   * is idempotent and a failure never stops the next one. Never touches the
   * delivery branch, evidence, or directories without a lease.
   */
  cleanupRun(runId: string, repoPath: string): Promise<RunCleanupResult>;
}

export interface RunCleanupResult {
  removedWorktrees: string[];
  /** Lease directories that were already gone; the lease is released anyway. */
  missingWorktrees: string[];
  deletedBranches: string[];
  missingBranches: string[];
  failures: Array<{ step: 'worktree' | 'prune' | 'branch-list' | 'branch'; target: string; message: string }>;
}

export function createWorktreeManager(options: {
  repositories: TekonRepositories;
  gateway: CommandGateway;
}): WorktreeManager {
  return {
    async ensureRunBranch(input) {
      const repoPath = resolve(input.repoPath);
      const runSegment = assertSafePathSegment(input.runId);
      const branchName = deliveryBranchName(runSegment);
      const existing = await runGit(options.gateway, {
        repoPath,
        runId: runSegment,
        args: ['branch', '--list', branchName],
      });
      if (existing.trim().length === 0) {
        await runGit(options.gateway, {
          repoPath,
          runId: runSegment,
          args: ['branch', branchName, input.baseRef],
        });
      }
      return branchName;
    },

    async createLease(input) {
      const repoPath = resolve(input.repoPath);
      const runSegment = assertSafePathSegment(input.runId);
      const nodeSegment = assertSafePathSegment(input.nodeId);
      const roleSegment = assertSafePathSegment(input.role);
      const dirtyStatus = await runGit(options.gateway, {
        repoPath,
        runId: runSegment,
        args: ['status', '--porcelain=v1', '-z'],
      });
      const meaningfulDirtyLines = meaningfulDirtyStatusLines(dirtyStatus);

      if (meaningfulDirtyLines.length > 0 && !input.allowDirtyBase) {
        throw new Error('dirty base worktree requires allowDirtyBase');
      }

      const leaseSegment = `lease-${randomUUID()}`;
      const suffix = `${nodeSegment}-${roleSegment}-${leaseSegment}`;
      const worktreePath = join(
        repoPath,
        '.tekon',
        'worktrees',
        runSegment,
        suffix,
      );
      const branchName = `tekon/${runSegment}/${suffix}`;
      const baseHead = (
        await runGit(options.gateway, {
          repoPath,
          runId: runSegment,
          args: ['rev-parse', input.baseRef],
        })
      ).trim();

      // Create the lease from the immutable OID we persist, not from the
      // movable branch name. Otherwise another promotion between rev-parse and
      // worktree add can make the lease's actual base differ from baseHead,
      // causing the later expected-old-OID CAS to use the wrong generation.
      await runGit(options.gateway, {
        repoPath,
        runId: runSegment,
        args: ['worktree', 'add', '-b', branchName, worktreePath, baseHead],
      });

      const lease: WorktreeLease = {
        id: `lease_${randomUUID()}`,
        runId: input.runId,
        nodeId: input.nodeId,
        role: input.role,
        repoPath,
        worktreePath,
        branchName,
        baseHead,
        createdAt: new Date().toISOString(),
      };

      return options.repositories.recordWorktreeLease(lease);
    },

    async commitLeaseChanges(leaseId, input) {
      const lease = await options.repositories.getWorktreeLease(leaseId);
      if (!lease) {
        throw new Error(`unknown worktree lease: ${leaseId}`);
      }
      assertManagedWorktreePath(lease.repoPath, lease.worktreePath);
      await resetTekonRuntimeIndex(options.gateway, lease);
      const meaningfulDirtyLines = await meaningfulLeaseDirtyLines(lease);

      if (meaningfulDirtyLines.length === 0) {
        return false;
      }
      const pathspecs = dirtyPathspecsFromStatusLines(meaningfulDirtyLines);

      if (pathspecs.length > 0) {
        await runGit(options.gateway, {
          repoPath: lease.worktreePath,
          runId: lease.runId,
          args: ['add', '--all', '--', ...pathspecs],
        });
      }
      await resetTekonRuntimeIndex(options.gateway, lease);
      await runGit(options.gateway, {
        repoPath: lease.worktreePath,
        runId: lease.runId,
        args: ['commit', '-m', input.message],
      });
      return true;
    },

    async inspectLeaseSourceChanges(leaseId) {
      return inspectLeaseSourceChanges(leaseId);
    },

    async listLeaseSourceChanges(leaseId) {
      return (await inspectLeaseSourceChanges(leaseId)).changedPaths;
    },

    async getLeaseHead(leaseId) {
      const lease = await options.repositories.getWorktreeLease(leaseId);
      if (!lease) {
        throw new Error(`unknown worktree lease: ${leaseId}`);
      }
      assertManagedWorktreePath(lease.repoPath, lease.worktreePath);
      return (
        await runGit(options.gateway, {
          repoPath: lease.worktreePath,
          runId: lease.runId,
          args: ['rev-parse', 'HEAD'],
        })
      ).trim();
    },

    async promoteLeaseToRunBranch(input) {
      const lease = await options.repositories.getWorktreeLease(input.leaseId);
      if (!lease) {
        throw new Error(`unknown worktree lease: ${input.leaseId}`);
      }
      assertManagedWorktreePath(lease.repoPath, lease.worktreePath);
      const branchName =
        input.branchName ??
        deliveryBranchName(assertSafePathSegment(lease.runId));
      const targetRef = assertSafeBranchRef(branchName);
      if (!lease.baseHead) {
        throw new Error(
          `worktree lease ${lease.id} is missing baseHead; refusing unsafe promotion`,
        );
      }
      const leaseHeadOid = (
        await runGit(options.gateway, {
          repoPath: lease.repoPath,
          runId: lease.runId,
          args: ['rev-parse', '--verify', lease.branchName],
        })
      ).trim();

      // Fence against the ref value this lease was actually created from.
      // Reading the target immediately before update-ref is not sufficient: a
      // stale lease can observe a newer promotion and then successfully replace
      // it. The persisted baseHead is the lease's durable expected-old OID, so
      // only a promoter based on the current delivery head can win.
      await runGit(options.gateway, {
        repoPath: lease.repoPath,
        runId: lease.runId,
        args: ['update-ref', targetRef, leaseHeadOid, lease.baseHead],
      });
      return branchName;
    },

    async releaseLease(leaseId) {
      const lease = await options.repositories.getWorktreeLease(leaseId);
      if (!lease) {
        throw new Error(`unknown worktree lease: ${leaseId}`);
      }
      assertManagedWorktreePath(lease.repoPath, lease.worktreePath);
      await runGit(options.gateway, {
        repoPath: lease.repoPath,
        runId: lease.runId,
        args: ['worktree', 'remove', '--force', lease.worktreePath],
      });
      await options.repositories.releaseWorktreeLease(
        leaseId,
        new Date().toISOString(),
      );
    },

    async pruneStaleLeases(repoPath) {
      await runGit(options.gateway, {
        repoPath: resolve(repoPath),
        runId: 'worktree-prune',
        args: ['worktree', 'prune'],
      });
    },

    async listLeases(runId) {
      return options.repositories.listWorktreeLeases(runId);
    },

    listRunBranches,

    async cleanupRun(runId, repoPath) {
      const runSegment = assertSafePathSegment(runId);
      const root = resolve(repoPath);
      const result: RunCleanupResult = {
        removedWorktrees: [], missingWorktrees: [], deletedBranches: [],
        missingBranches: [], failures: [],
      };
      const message = (error: unknown) => error instanceof Error ? error.message : String(error);
      // Leases recorded for another repository path are left alone.
      const leases = (await options.repositories.listWorktreeLeases(runId))
        .filter((lease) => isLeaseOfRepo(lease, root));
      // A branch stays while a worktree that checks it out could not be removed.
      const keptBranches = new Set<string>();

      for (const lease of leases.filter((item) => !item.releasedAt)) {
        try {
          assertManagedWorktreePath(lease.repoPath, lease.worktreePath);
          if (existsSync(lease.worktreePath)) {
            await runGit(options.gateway, {
              repoPath: root,
              runId: runSegment,
              args: ['worktree', 'remove', '--force', lease.worktreePath],
            });
            result.removedWorktrees.push(lease.worktreePath);
          } else {
            result.missingWorktrees.push(lease.worktreePath);
          }
          await options.repositories.releaseWorktreeLease(lease.id, new Date().toISOString());
        } catch (error) {
          keptBranches.add(lease.branchName);
          result.failures.push({ step: 'worktree', target: lease.worktreePath, message: message(error) });
        }
      }

      // Drops records of removed directories so their branches can be deleted.
      try {
        await runGit(options.gateway, { repoPath: root, runId: runSegment, args: ['worktree', 'prune'] });
      } catch (error) {
        result.failures.push({ step: 'prune', target: root, message: message(error) });
      }

      let existing: Set<string>;
      try {
        existing = new Set(await listRunBranches(runId, root));
      } catch (error) {
        result.failures.push({ step: 'branch-list', target: root, message: message(error) });
        return result;
      }
      const prefix = `tekon/${runSegment}/`;
      for (const branchName of [...new Set(leases.map((lease) => lease.branchName))]) {
        if (keptBranches.has(branchName)) continue;
        try {
          if (!branchName.startsWith(prefix)) {
            throw new Error(`not a node branch of ${runId}`);
          }
          assertSafeBranchRef(branchName);
          if (!existing.has(branchName)) {
            result.missingBranches.push(branchName);
            continue;
          }
          await runGit(options.gateway, {
            repoPath: root,
            runId: runSegment,
            args: ['branch', '-D', branchName],
          });
          result.deletedBranches.push(branchName);
        } catch (error) {
          result.failures.push({ step: 'branch', target: branchName, message: message(error) });
        }
      }
      return result;
    },
  };

  async function listRunBranches(runId: string, repoPath: string): Promise<string[]> {
    const runSegment = assertSafePathSegment(runId);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-git-read-'));
    try {
      const output = await runGit(options.gateway, {
        repoPath: resolve(repoPath),
        runId: runSegment,
        outputDir,
        args: ['for-each-ref', '--format=%(refname:short)', `refs/heads/tekon/${runSegment}/`],
      });
      return output.split('\n').map((line) => line.trim()).filter(Boolean);
    } finally {
      rmSync(outputDir, { recursive: true, force: true });
    }
  }

  async function meaningfulLeaseDirtyLines(
    lease: WorktreeLease,
  ): Promise<PorcelainStatusEntry[]> {
    const dirtyStatus = await runGit(options.gateway, {
      repoPath: lease.worktreePath,
      runId: lease.runId,
      args: ['status', '--porcelain=v1', '-z'],
    });
    return meaningfulDirtyStatusLines(dirtyStatus);
  }

  async function inspectLeaseSourceChanges(leaseId: string): Promise<{
    changedPaths: string[];
    headChanged: boolean;
    baseHead?: string | null;
    currentHead: string;
  }> {
    const lease = await options.repositories.getWorktreeLease(leaseId);
    if (!lease) {
      throw new Error(`unknown worktree lease: ${leaseId}`);
    }
    assertManagedWorktreePath(lease.repoPath, lease.worktreePath);
    await resetTekonRuntimeIndex(options.gateway, lease);
    const paths = new Set<string>();
    for (const entry of await meaningfulLeaseDirtyLines(lease)) {
      for (const path of statusEntryPaths(entry)) {
        if (!isTekonRuntimePath(path)) {
          paths.add(path);
        }
      }
    }
    const currentHead = (
      await runGit(options.gateway, {
        repoPath: lease.worktreePath,
        runId: lease.runId,
        args: ['rev-parse', 'HEAD'],
      })
    ).trim();
    if (lease.baseHead) {
      const committedDiff = await runGit(options.gateway, {
        repoPath: lease.worktreePath,
        runId: lease.runId,
        args: ['diff', '--name-only', '-z', lease.baseHead, currentHead, '--'],
      });
      for (const path of committedDiff
        .split('\0')
        .filter((item) => item.length > 0)) {
        if (!isTekonRuntimePath(path)) {
          paths.add(path);
        }
      }
    }
    return {
      changedPaths: [...paths].sort(),
      headChanged: Boolean(lease.baseHead) && currentHead !== lease.baseHead,
      baseHead: lease.baseHead,
      currentHead,
    };
  }
}

async function resetTekonRuntimeIndex(
  gateway: CommandGateway,
  lease: WorktreeLease,
): Promise<void> {
  await runGit(gateway, {
    repoPath: lease.worktreePath,
    runId: lease.runId,
    args: ['restore', '--staged', '--ignore-unmerged', '--', '.tekon'],
    allowFailure: true,
  });
}

type PorcelainStatusEntry = {
  code: string;
  path: string;
  sourcePath?: string;
};

function meaningfulDirtyStatusLines(status: string): PorcelainStatusEntry[] {
  return parsePorcelainStatus(status).filter((entry) =>
    statusEntryPaths(entry).some((path) => !isTekonRuntimePath(path)),
  );
}

function dirtyPathspecsFromStatusLines(
  lines: PorcelainStatusEntry[],
): string[] {
  const pathspecs = new Set<string>();
  for (const entry of lines) {
    if (shouldStagePath(entry) && !isTekonRuntimePath(entry.path)) {
      pathspecs.add(entry.path);
    }
  }
  return [...pathspecs];
}

function shouldStagePath(entry: PorcelainStatusEntry): boolean {
  if (entry.code === '??') {
    return true;
  }
  const indexStatus = entry.code[0];
  const worktreeStatus = entry.code[1];
  if (worktreeStatus && worktreeStatus !== ' ') {
    return true;
  }
  return indexStatus !== 'D';
}

function parsePorcelainStatus(status: string): PorcelainStatusEntry[] {
  const fields = status.split('\0').filter((field) => field.length > 0);
  const entries: PorcelainStatusEntry[] = [];
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    const code = field.slice(0, 2);
    const firstPath = field.slice(3);
    if (!firstPath) {
      continue;
    }
    if (code[0] === 'R' || code[0] === 'C') {
      const sourcePath = fields[index + 1];
      index += sourcePath ? 1 : 0;
      entries.push({
        code,
        path: firstPath,
        ...(sourcePath ? { sourcePath } : {}),
      });
      continue;
    }
    entries.push({ code, path: firstPath });
  }
  return entries;
}

function statusEntryPaths(entry: PorcelainStatusEntry): string[] {
  return entry.sourcePath ? [entry.path, entry.sourcePath] : [entry.path];
}

function isTekonRuntimePath(path: string): boolean {
  return path === '.tekon' || path.startsWith('.tekon/');
}

async function runGit(
  gateway: CommandGateway,
  input: {
    repoPath: string;
    runId: string;
    args: string[];
    allowFailure?: boolean;
    /** Defaults to the run's command log directory. */
    outputDir?: string;
  },
): Promise<string> {
  const result = await gateway.run({
    command: { tool: 'git', args: input.args },
    cwd: input.repoPath,
    outputDir: input.outputDir ?? join(input.repoPath, '.tekon', 'runs', input.runId, 'commands'),
    policy: {
      allow: [{ tool: 'git', args: [] }],
      deny: [
        { tool: 'git', args: ['push'] },
        { tool: 'git', args: ['push', '--force'] },
      ],
      requiresHumanApproval: [],
      cwdScope: [input.repoPath],
      network: 'disabled',
    },
  });

  if (result.status !== 'executed') {
    throw new Error(`git command rejected: ${result.status}`);
  }

  const stdout = readFileSync(result.stdoutPath, 'utf8');
  const stderr = readFileSync(result.stderrPath, 'utf8');
  if (result.exitCode !== 0 && !input.allowFailure) {
    throw new Error(`git command failed: ${stderr || stdout}`);
  }
  return stdout;
}

/** The same directory reached through a symlink (e.g. /var on macOS) compares equal. */
/** Whether a lease was recorded for this repository, after resolving links. */
export function isLeaseOfRepo(lease: Pick<WorktreeLease, 'repoPath'>, repoPath: string): boolean {
  return canonicalPath(lease.repoPath) === canonicalPath(repoPath);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function assertSafePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw new Error(`unsafe path segment: ${value}`);
  }
  return value;
}

function assertSafeBranchRef(branchName: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/u.test(branchName)) {
    throw new Error(`unsafe branch name: ${branchName}`);
  }
  if (
    branchName.includes('..') ||
    branchName.includes('//') ||
    branchName.endsWith('/') ||
    branchName.endsWith('.') ||
    branchName.endsWith('.lock')
  ) {
    throw new Error(`unsafe branch name: ${branchName}`);
  }
  return `refs/heads/${branchName}`;
}

function deliveryBranchName(runSegment: string): string {
  return `tekon-delivery/${runSegment}`;
}

function assertManagedWorktreePath(
  repoPath: string,
  worktreePath: string,
): void {
  const root = resolve(repoPath, '.tekon', 'worktrees');
  const target = resolve(worktreePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(
      `refusing to remove unmanaged worktree path: ${worktreePath}`,
    );
  }
}
