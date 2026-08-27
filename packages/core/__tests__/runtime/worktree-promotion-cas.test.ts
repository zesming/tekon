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
  it('updates the delivery ref with the exact old OID observed before promotion', async () => {
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

    const lease: WorktreeLease = {
      id: 'lease_1',
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'rd',
      repoPath,
      worktreePath,
      branchName: 'tekon/run_1/node_1-rd-lease-1',
      baseHead: 'base-oid',
      createdAt: '2026-08-27T00:00:00.000Z',
    };
    const calls: string[][] = [];
    const oldOid = '1111111111111111111111111111111111111111';
    const newOid = '2222222222222222222222222222222222222222';
    let callIndex = 0;

    const gateway = {
      async run(input) {
        const args = input.command.args;
        calls.push(args);
        const stdoutPath = join(repoPath, `stdout-${callIndex}.log`);
        const stderrPath = join(repoPath, `stderr-${callIndex}.log`);
        const progressPath = join(repoPath, `progress-${callIndex}.json`);
        callIndex += 1;
        const stdout =
          args[0] === 'rev-parse'
            ? args[2] === 'refs/heads/tekon-delivery/run_1'
              ? `${oldOid}\n`
              : `${newOid}\n`
            : '';
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
      [
        'rev-parse',
        '--verify',
        'refs/heads/tekon-delivery/run_1',
      ],
      ['rev-parse', '--verify', lease.branchName],
      [
        'update-ref',
        'refs/heads/tekon-delivery/run_1',
        newOid,
        oldOid,
      ],
    ]);
  });
});
