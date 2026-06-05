import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import type { Role } from '../types/domain.js';
import type { WorktreeLease } from '../types/config.js';
import type { DonkeyRepositories } from '../db/repositories.js';
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
  createLease(input: CreateLeaseInput): Promise<WorktreeLease>;
  releaseLease(leaseId: string): Promise<void>;
  pruneStaleLeases(repoPath: string): Promise<void>;
  listLeases(runId: string): Promise<WorktreeLease[]>;
}

export function createWorktreeManager(options: {
  repositories: DonkeyRepositories;
  gateway: CommandGateway;
}): WorktreeManager {
  return {
    async createLease(input) {
      const repoPath = resolve(input.repoPath);
      const dirtyStatus = await runGit(options.gateway, {
        repoPath,
        runId: input.runId,
        args: ['status', '--porcelain'],
      });
      const meaningfulDirtyLines = dirtyStatus
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .filter((line) => !line.startsWith('?? .donkey/'));

      if (meaningfulDirtyLines.length > 0 && !input.allowDirtyBase) {
        throw new Error('dirty base worktree requires allowDirtyBase');
      }

      const suffix = `${safeSegment(input.nodeId)}-${safeSegment(input.role)}`;
      const worktreePath = join(repoPath, '.donkey', 'worktrees', input.runId, suffix);
      const branchName = `donkey/${safeSegment(input.runId)}/${suffix}`;

      await runGit(options.gateway, {
        repoPath,
        runId: input.runId,
        args: ['worktree', 'add', '-b', branchName, worktreePath, input.baseRef],
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
      await options.repositories.releaseWorktreeLease(leaseId, new Date().toISOString());
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
    outputDir: join(input.repoPath, '.donkey', 'runs', input.runId, 'commands'),
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

function safeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/gu, '-');
}

function assertManagedWorktreePath(repoPath: string, worktreePath: string): void {
  const root = resolve(repoPath, '.donkey', 'worktrees');
  const target = resolve(worktreePath);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`refusing to remove unmanaged worktree path: ${worktreePath}`);
  }
}
