import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  promoteLeaseToRunBranch(input: {
    leaseId: string;
    branchName?: string;
  }): Promise<string>;
  releaseLease(leaseId: string): Promise<void>;
  pruneStaleLeases(repoPath: string): Promise<void>;
  listLeases(runId: string): Promise<WorktreeLease[]>;
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
        args: ['status', '--porcelain'],
      });
      const meaningfulDirtyLines = dirtyStatus
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .filter((line) => !line.startsWith('?? .tekon/'));

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

      await runGit(options.gateway, {
        repoPath,
        runId: runSegment,
        args: [
          'worktree',
          'add',
          '-b',
          branchName,
          worktreePath,
          input.baseRef,
        ],
      });

      const lease: WorktreeLease = {
        id: `lease_${randomUUID()}`,
        runId: input.runId,
        nodeId: input.nodeId,
        role: input.role,
        repoPath,
        worktreePath,
        branchName,
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
      const dirtyStatus = await runGit(options.gateway, {
        repoPath: lease.worktreePath,
        runId: lease.runId,
        args: ['status', '--porcelain'],
      });
      const meaningfulDirtyLines = dirtyStatus
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .filter((line) => !line.startsWith('?? .tekon/'));

      if (meaningfulDirtyLines.length === 0) {
        return false;
      }

      await runGit(options.gateway, {
        repoPath: lease.worktreePath,
        runId: lease.runId,
        args: ['add', '.', ':!.tekon'],
      });
      await runGit(options.gateway, {
        repoPath: lease.worktreePath,
        runId: lease.runId,
        args: ['commit', '-m', input.message],
      });
      return true;
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
      await runGit(options.gateway, {
        repoPath: lease.repoPath,
        runId: lease.runId,
        args: ['branch', '-f', branchName, lease.branchName],
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
  };
}

async function runGit(
  gateway: CommandGateway,
  input: { repoPath: string; runId: string; args: string[] },
): Promise<string> {
  const result = await gateway.run({
    command: { tool: 'git', args: input.args },
    cwd: input.repoPath,
    outputDir: join(input.repoPath, '.tekon', 'runs', input.runId, 'commands'),
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
  if (result.exitCode !== 0) {
    throw new Error(`git command failed: ${stderr || stdout}`);
  }
  return stdout;
}

function assertSafePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw new Error(`unsafe path segment: ${value}`);
  }
  return value;
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
