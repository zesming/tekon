import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  createWorktreeManager,
  migrateDatabase,
  openDonkeyDatabase,
  type CommandGateway,
} from '../../src/index.js';

describe('worktree manager', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('rejects a dirty base worktree unless explicitly allowed', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-worktree-unit-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const calls: string[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(`${input.command.tool} ${input.command.args.join(' ')}`);
        const stdoutPath = join(repoPath, 'stdout.log');
        const stderrPath = join(repoPath, 'stderr.log');
        writeFileSync(stdoutPath, ' M changed.ts\n', 'utf8');
        writeFileSync(stderrPath, '', 'utf8');
        return {
          status: 'executed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath,
          stderrPath,
          durationMs: 1,
        };
      },
    };

    const manager = createWorktreeManager({ repositories, gateway });

    await expect(
      manager.createLease({
        repoPath,
        runId: 'run_1',
        nodeId: 'node_1',
        role: 'rd',
        baseRef: 'HEAD',
      }),
    ).rejects.toThrow(/dirty base worktree/u);
    expect(calls).toEqual(['git status --porcelain']);
    db.close();
  });

  it('rejects unsafe run identifiers before git worktree add', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-worktree-path-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const calls: string[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input.command.args.join(' '));
        const stdoutPath = join(repoPath, `${calls.length}.stdout.log`);
        const stderrPath = join(repoPath, `${calls.length}.stderr.log`);
        writeFileSync(stdoutPath, '', 'utf8');
        writeFileSync(stderrPath, '', 'utf8');
        return {
          status: 'executed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath,
          stderrPath,
          durationMs: 1,
        };
      },
    };

    const manager = createWorktreeManager({ repositories, gateway });

    await expect(
      manager.createLease({
        repoPath,
        runId: '../escape',
        nodeId: 'node_1',
        role: 'rd',
        baseRef: 'HEAD',
      }),
    ).rejects.toThrow(/unsafe path segment/u);
    expect(calls).toEqual([]);
    db.close();
  });
});
