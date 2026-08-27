import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  createWorktreeManager,
  migrateDatabase,
  openTekonDatabase,
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
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-worktree-unit-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
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
    expect(calls).toEqual(['git status --porcelain=v1 -z']);
    db.close();
  });

  it('creates the worktree from the same immutable OID persisted as baseHead', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-worktree-base-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const calls: string[][] = [];
    const baseOid = '1111111111111111111111111111111111111111';
    let callIndex = 0;
    const gateway: CommandGateway = {
      async run(input) {
        calls.push([...input.command.args]);
        const stdoutPath = join(repoPath, `${callIndex}.stdout.log`);
        const stderrPath = join(repoPath, `${callIndex}.stderr.log`);
        callIndex += 1;
        writeFileSync(
          stdoutPath,
          input.command.args[0] === 'rev-parse' ? `${baseOid}\n` : '',
          'utf8',
        );
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
    const lease = await manager.createLease({
      repoPath,
      runId: 'run_1',
      nodeId: 'node_1',
      role: 'rd',
      baseRef: 'tekon-delivery/run_1',
    });

    expect(lease.baseHead).toBe(baseOid);
    expect(calls[0]).toEqual(['status', '--porcelain=v1', '-z']);
    expect(calls[1]).toEqual(['rev-parse', 'tekon-delivery/run_1']);
    expect(calls[2]?.slice(0, 4)).toEqual([
      'worktree',
      'add',
      '-b',
      lease.branchName,
    ]);
    expect(calls[2]?.at(-1)).toBe(baseOid);
    db.close();
  });

  it('rejects unsafe run identifiers before git worktree add', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-worktree-path-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
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
