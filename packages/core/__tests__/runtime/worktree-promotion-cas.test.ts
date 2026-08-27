import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWorktreeManager } from '../../src/index.js';
import type { TekonRepositories } from '../../src/db/repositories.js';
import type { CommandGateway } from '../../src/runtime/command-gateway.js';
import type { WorktreeLease } from '../../src/types/config.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('worktree promotion compare-and-swap', () => {
  it('uses the lease creation baseHead as the expected old OID', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-promotion-cas-'));
    tempDirs.push(repoPath);
    const worktreePath = join(
      repoPath,
      '.tekon',
      'worktrees',
      'run_1',
      'node_1-rd-lease-1',
    );
    mkdirSync(worktreePath, { recursive: true });

    const baseOid = '1111111111111111111111111111111111111111';
    const newOid = '2222222222222222222222222222222222222222';
    const lease: WorktreeLease = {
      id: 'lease_1',
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'rd',
      repoPath,
      worktreePath,
      branchName: 'tekon/run_1/node_1-rd-lease-1',
      baseHead: baseOid,
      createdAt: '2026-08-27T00:00:00.000Z',
    };
    const calls: string[][] = [];
    let callIndex = 0;

    const gateway = {
      async run(input) {
        const args = input.command.args;
        calls.push(args);
        const stdoutPath = join(repoPath, `stdout-${callIndex}.log`);
        const stderrPath = join(repoPath, `stderr-${callIndex}.log`);
        const progressPath = join(repoPath, `progress-${callIndex}.json`);
        callIndex += 1;
        const stdout = args[0] === 'rev-parse' ? `${newOid}\n` : '';
        writeFileSync(stdoutPath, stdout);
        writeFileSync(stderrPath, '');
        writeFileSync(progressPath, '{}');
        return {
          status: 'executed' as const,
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath,
          stderrPath,
          progressPath,
          durationMs: 1,
        };
      },
    } satisfies Pick<CommandGateway, 'run'>;

    const manager = createWorktreeManager({
      repositories: {
        getWorktreeLease: async () => lease,
      } as unknown as TekonRepositories,
      gateway: gateway as CommandGateway,
    });

    await expect(
      manager.promoteLeaseToRunBranch({ leaseId: lease.id }),
    ).resolves.toBe('tekon-delivery/run_1');
    expect(calls).toEqual([
      ['rev-parse', '--verify', lease.branchName],
      [
        'update-ref',
        'refs/heads/tekon-delivery/run_1',
        newOid,
        baseOid,
      ],
    ]);
  });

  it('fails closed when a legacy lease has no durable baseHead', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-promotion-no-base-'));
    tempDirs.push(repoPath);
    const worktreePath = join(
      repoPath,
      '.tekon',
      'worktrees',
      'run_1',
      'node_1-rd-lease-legacy',
    );
    mkdirSync(worktreePath, { recursive: true });

    const lease: WorktreeLease = {
      id: 'lease_legacy',
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'rd',
      repoPath,
      worktreePath,
      branchName: 'tekon/run_1/node_1-rd-lease-legacy',
      baseHead: null,
      createdAt: '2026-08-27T00:00:00.000Z',
    };
    let gatewayCalls = 0;
    const gateway = {
      async run() {
        gatewayCalls += 1;
        throw new Error('git must not run without a durable promotion basis');
      },
    } satisfies Pick<CommandGateway, 'run'>;
    const manager = createWorktreeManager({
      repositories: {
        getWorktreeLease: async () => lease,
      } as unknown as TekonRepositories,
      gateway: gateway as CommandGateway,
    });

    await expect(
      manager.promoteLeaseToRunBranch({ leaseId: lease.id }),
    ).rejects.toThrow(/missing baseHead/u);
    expect(gatewayCalls).toBe(0);
  });
});
