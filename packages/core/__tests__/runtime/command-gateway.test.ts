import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createCommandGateway,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('command gateway', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('rejects dangerous commands and shell metacharacters before spawn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-command-'));
    tempDirs.push(cwd);
    let spawnCalls = 0;
    const gateway = createCommandGateway({
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
    });

    const policy = {
      allow: [{ tool: 'git', args: [] }],
      deny: [{ tool: 'git', args: ['push', '--force'] }],
      cwdScope: [cwd],
      network: 'disabled' as const,
    };

    await expect(
      gateway.run({ command: { tool: 'rm', args: ['-rf', cwd] }, cwd, policy }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({
        command: { tool: 'git', args: ['push', '--force'] },
        cwd,
        policy,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({
        command: { tool: 'git', args: ['status', ';', 'rm'] },
        cwd,
        policy,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({
        command: { tool: '/bin/git', args: ['status'] },
        cwd,
        policy,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({
        command: { tool: 'rm', args: ['-r', '-f', cwd] },
        cwd,
        policy,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    await expect(
      gateway.run({
        command: {
          tool: 'git',
          args: ['push', 'origin', 'main', '--force-with-lease'],
        },
        cwd,
        policy,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });

    expect(spawnCalls).toBe(0);
  });

  it('does not treat an empty allow list as allow all', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-command-empty-allow-'));
    tempDirs.push(cwd);
    let spawnCalls = 0;
    const gateway = createCommandGateway({
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
    });

    await expect(
      gateway.run({
        command: { tool: 'git', args: ['status'] },
        cwd,
        policy: { allow: [], deny: [], cwdScope: [cwd], network: 'disabled' },
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(spawnCalls).toBe(0);
  });

  it('blocks cwd outside policy scope before spawn', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'donkey-allowed-'));
    const outside = mkdtempSync(join(tmpdir(), 'donkey-outside-'));
    tempDirs.push(allowed, outside);
    let spawnCalls = 0;
    const gateway = createCommandGateway({
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
    });

    await expect(
      gateway.run({
        command: { tool: 'git', args: ['status'] },
        cwd: outside,
        policy: {
          allow: [{ tool: 'git', args: [] }],
          deny: [],
          cwdScope: [allowed],
          network: 'disabled',
        },
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(spawnCalls).toBe(0);
  });

  it('creates a pending human decision and does not spawn when approval is required', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-approval-'));
    tempDirs.push(cwd);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, cwd);
    let spawnCalls = 0;

    const gateway = createCommandGateway({
      repositories,
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
    });

    const result = await gateway.run({
      command: { tool: 'git', args: ['commit'] },
      cwd,
      runId: 'run_1',
      nodeId: 'node_1',
      policy: {
        allow: [{ tool: 'git', args: [] }],
        deny: [],
        requiresHumanApproval: [{ tool: 'git', args: ['commit'] }],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({ status: 'blocked-for-approval' });
    expect(await repositories.listHumanDecisions('run_1')).toMatchObject([
      { nodeId: 'node_1', status: 'pending' },
    ]);
    expect(spawnCalls).toBe(0);
    db.close();
  });

  it('executes allowed argv commands and streams stdout and stderr to log files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-exec-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: [
          '-e',
          "process.stdout.write('hello\\n')\nprocess.stderr.write('warn\\n')",
        ],
      },
      cwd,
      outputDir: join(cwd, 'logs'),
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({
      status: 'executed',
      exitCode: 0,
      timedOut: false,
    });
    if (result.status !== 'executed') {
      throw new Error('expected command to execute');
    }
    expect(readFileSync(result.stdoutPath, 'utf8')).toContain('hello');
    expect(readFileSync(result.stderrPath, 'utf8')).toContain('warn');
  });

  it('redacts likely secrets from command stdout and stderr logs', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-exec-redact-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: [
          '-e',
          [
            'process.stdout.write(\'token = "sk-123456789012345678901234"\\n\')',
            'process.stderr.write(\'secret = "123456789012345678901234567890"\\n\')',
          ].join('\n'),
        ],
      },
      cwd,
      outputDir: join(cwd, 'logs'),
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({ status: 'executed', exitCode: 0 });
    if (result.status !== 'executed') {
      throw new Error('expected command to execute');
    }
    const stdout = readFileSync(result.stdoutPath, 'utf8');
    const stderr = readFileSync(result.stderrPath, 'utf8');
    expect(stdout).not.toContain('sk-123456789012345678901234');
    expect(stderr).not.toContain('123456789012345678901234567890');
    expect(stdout).toContain('[REDACTED_OPENAI_API_KEY]');
    expect(stderr).toContain('[REDACTED_SECRET]');
  });

  it('redacts likely secrets that are split across stdout and stderr chunks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-exec-redact-chunks-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
        setImmediate(() => {
          child.stdout.write('token = "sk-1234567890');
          child.stdout.write('12345678901234"\n');
          child.stderr.write('secret = "123456789012');
          child.stderr.write('345678901234567890"\n');
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    const result = await gateway.run({
      command: { tool: 'node', args: ['script.js'] },
      cwd,
      outputDir: join(cwd, 'logs'),
      policy: {
        allow: [{ tool: 'node', args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({ status: 'executed', exitCode: 0 });
    if (result.status !== 'executed') {
      throw new Error('expected command to execute');
    }
    const stdout = readFileSync(result.stdoutPath, 'utf8');
    const stderr = readFileSync(result.stderrPath, 'utf8');
    expect(stdout).not.toContain('sk-123456789012345678901234');
    expect(stderr).not.toContain('123456789012345678901234567890');
    expect(stdout).toContain('[REDACTED_OPENAI_API_KEY]');
    expect(stderr).toContain('[REDACTED_SECRET]');
  });

  it('closes child stdin without writing a chunk when no stdin is provided', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-stdin-close-'));
    tempDirs.push(cwd);
    let stdinWrites = 0;
    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            stdinWrites += 1;
            callback();
          },
        });
        child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
        setImmediate(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    await expect(
      gateway.run({
        command: { tool: 'git', args: ['status'] },
        cwd,
        policy: {
          allow: [{ tool: 'git', args: [] }],
          deny: [],
          cwdScope: [cwd],
          network: 'disabled',
        },
      }),
    ).resolves.toMatchObject({ status: 'executed', exitCode: 0 });
    expect(stdinWrites).toBe(0);
  });

  it('rejects the command result when required stdin cannot be written', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-stdin-error-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback(new Error('write EPIPE'));
          },
        });
        child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
        child.stdin.once('error', () => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    await expect(
      gateway.run({
        command: { tool: 'node', args: ['script.js'] },
        cwd,
        stdin: 'required prompt',
        policy: {
          allow: [{ tool: 'node', args: [] }],
          deny: [],
          cwdScope: [cwd],
          network: 'disabled',
        },
      }),
    ).resolves.toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('failed to write command stdin'),
    });
  });

  it('keeps no-stdin child pipe errors from overriding the child exit result', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-no-stdin-epipe-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
        setImmediate(() => {
          child.stdin.emit('error', new Error('write EPIPE'));
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        });
        return child;
      },
    });

    await expect(
      gateway.run({
        command: { tool: 'git', args: ['status'] },
        cwd,
        policy: {
          allow: [{ tool: 'git', args: [] }],
          deny: [],
          cwdScope: [cwd],
          network: 'disabled',
        },
      }),
    ).resolves.toMatchObject({ status: 'executed', exitCode: 0 });
  });

  it('rejects when the spawned child emits an asynchronous error before close', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-child-error-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
        setImmediate(() => {
          if (child.listenerCount('error') > 0) {
            child.emit('error', new Error('spawn ENOENT'));
          }
          child.stdout.end();
          child.stderr.end();
        });
        return child;
      },
    });

    const result = await Promise.race([
      gateway.run({
        command: { tool: 'missing-tool', args: [] },
        cwd,
        policy: {
          allow: [{ tool: 'missing-tool', args: [] }],
          deny: [],
          cwdScope: [cwd],
          network: 'disabled',
        },
      }),
      new Promise((resolve) =>
        setTimeout(() => resolve({ status: 'timed-out' }), 100),
      ),
    ]);

    expect(result).toMatchObject({
      status: 'rejected',
      reason: expect.stringContaining('spawn ENOENT'),
    });
  });

  it('rejects executed commands when stdout logs cannot be written', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-log-error-'));
    tempDirs.push(cwd);
    const outputDir = join(cwd, 'logs');
    mkdirSync(outputDir);
    chmodSync(outputDir, 0o500);
    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        child.kill = (() => true) as ChildProcessWithoutNullStreams['kill'];
        setTimeout(() => {
          child.stdout.write('evidence\n');
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        }, 50);
        return child;
      },
    });

    try {
      await expect(
        gateway.run({
          command: { tool: 'node', args: ['script.js'] },
          cwd,
          outputDir,
          policy: {
            allow: [{ tool: 'node', args: [] }],
            deny: [],
            cwdScope: [cwd],
            network: 'disabled',
          },
        }),
      ).resolves.toMatchObject({
        status: 'rejected',
        reason: expect.stringContaining('failed to write command logs'),
      });
    } finally {
      chmodSync(outputDir, 0o700);
    }
  });

  it('settles timed-out commands even when the child never emits close', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'donkey-timeout-hang-'));
    tempDirs.push(cwd);
    const signals: NodeJS.Signals[] = [];
    const processKill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    });
    const gateway = createCommandGateway({
      spawnImpl: () => {
        const child = new EventEmitter() as ChildProcessWithoutNullStreams;
        child.pid = 987_654;
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.stdin = new Writable({
          write(_chunk, _encoding, callback) {
            callback();
          },
        });
        child.kill = ((signal?: NodeJS.Signals) => {
          signals.push(signal ?? 'SIGTERM');
          return true;
        }) as ChildProcessWithoutNullStreams['kill'];
        return child;
      },
    });

    try {
      const result = await Promise.race([
        gateway.run({
          command: { tool: 'node', args: ['ignore-sigterm.js'] },
          cwd,
          timeoutMs: 10,
          policy: {
            allow: [{ tool: 'node', args: [] }],
            deny: [],
            cwdScope: [cwd],
            network: 'disabled',
          },
        }),
        new Promise((resolve) =>
          setTimeout(() => resolve({ status: 'hung' }), 200),
        ),
      ]);

      expect(result).toMatchObject({
        status: 'executed',
        timedOut: true,
        exitCode: null,
        signal: 'SIGKILL',
      });
      expect(processKill).toHaveBeenCalledWith(-987_654, 'SIGTERM');
      expect(processKill).toHaveBeenCalledWith(-987_654, 'SIGKILL');
      expect(signals).toContain('SIGTERM');
      expect(signals).toContain('SIGKILL');
    } finally {
      processKill.mockRestore();
    }
  });
});

async function createRunFixture(
  repositories: ReturnType<typeof createRepositories>,
  repoPath: string,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Command run',
    body: 'Run a command.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'donkey',
    repoPath,
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'running',
    currentNodeId: 'node_1',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    role: 'rd',
    status: 'running',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
}
