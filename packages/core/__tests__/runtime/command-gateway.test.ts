import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
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
  openTekonDatabase,
} from '../../src/index.js';

describe('command gateway', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('rejects dangerous commands and shell metacharacters before spawn', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-command-'));
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
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-command-empty-allow-'));
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

  it('rejects extra argv when a policy entry requires exact matching', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-command-exact-'));
    tempDirs.push(cwd);
    let spawnCalls = 0;
    const gateway = createCommandGateway({
      spawnImpl: () => {
        spawnCalls += 1;
        throw new Error('spawn should not be called');
      },
    });
    const policy = {
      allow: [{ tool: 'git', args: ['remote', '-v'], match: 'exact' as const }],
      deny: [],
      cwdScope: [cwd],
      network: 'enabled' as const,
    };

    await expect(
      gateway.run({
        command: { tool: 'git', args: ['remote', '-v', 'add', 'origin'] },
        cwd,
        policy,
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(spawnCalls).toBe(0);
  });

  it('does not allow path-like tool names through basename matching', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-command-path-tool-'));
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
        command: { tool: './git', args: ['remote', '-v'] },
        cwd,
        policy: {
          allow: [
            {
              tool: 'git',
              args: ['remote', '-v'],
              match: 'exact' as const,
            },
          ],
          deny: [],
          cwdScope: [cwd],
          network: 'enabled',
        },
      }),
    ).resolves.toMatchObject({ status: 'rejected' });
    expect(spawnCalls).toBe(0);
  });

  it('blocks cwd outside policy scope before spawn', async () => {
    const allowed = mkdtempSync(join(tmpdir(), 'tekon-allowed-'));
    const outside = mkdtempSync(join(tmpdir(), 'tekon-outside-'));
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
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-approval-'));
    tempDirs.push(cwd);
    const db = openTekonDatabase({ filename: ':memory:' });
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

  it('redacts secrets from pending human approval notes', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-approval-redact-'));
    tempDirs.push(cwd);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, cwd);
    const tokenValue = 'abcdefghijklmnopqrstuvwxyz123456';

    const gateway = createCommandGateway({ repositories });

    await gateway.run({
      command: {
        tool: 'gh',
        args: ['api', 'repos/example/private', `--token=${tokenValue}`],
      },
      cwd,
      runId: 'run_1',
      nodeId: 'node_1',
      policy: {
        allow: [{ tool: 'gh', args: ['api'] }],
        deny: [],
        requiresHumanApproval: [{ tool: 'gh', args: ['api'] }],
        cwdScope: [cwd],
        network: 'enabled',
      },
    });

    const [decision] = await repositories.listHumanDecisions('run_1');
    expect(decision?.note).toContain('--token=[REDACTED_SECRET]');
    expect(decision?.note).not.toContain(tokenValue);
    db.close();
  });

  it('executes allowed argv commands and streams stdout and stderr to log files', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-'));
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

  it('writes progress heartbeat evidence for long-running commands', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-progress-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: [
          '-e',
          [
            "process.stdout.write('started\\n')",
            "setTimeout(() => process.stderr.write('still-running\\n'), 20)",
            'setTimeout(() => process.exit(0), 60)',
          ].join('\n'),
        ],
      },
      cwd,
      outputDir: join(cwd, 'logs'),
      progressIntervalMs: 10,
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
    expect(result.progressPath).toMatch(/\.progress\.json$/u);
    const progress = JSON.parse(readFileSync(result.progressPath!, 'utf8')) as {
      status: string;
      timeoutMs: number;
      stdoutBytes: number;
      stderrBytes: number;
      heartbeatCount: number;
      lastOutputAt: string | null;
    };
    expect(progress).toMatchObject({
      status: 'completed',
      timeoutMs: 60_000,
    });
    expect(progress.stdoutBytes).toBeGreaterThan(0);
    expect(progress.stderrBytes).toBeGreaterThan(0);
    expect(progress.heartbeatCount).toBeGreaterThan(0);
    expect(progress.lastOutputAt).toEqual(expect.any(String));
  });

  it('terminates commands after the no-progress timeout even before total timeout', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-no-progress-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000)'],
      },
      cwd,
      outputDir: join(cwd, 'logs'),
      timeoutMs: 5_000,
      noProgressTimeoutMs: 50,
      progressIntervalMs: 10,
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({
      status: 'executed',
      timedOut: true,
      timeoutReason: 'no-progress',
    });
    if (result.status !== 'executed') {
      throw new Error('expected command to execute');
    }
    const progress = JSON.parse(readFileSync(result.progressPath!, 'utf8')) as {
      status: string;
      timeoutReason: string;
      noProgressTimeoutMs: number;
    };
    expect(progress).toMatchObject({
      status: 'timed-out',
      timeoutReason: 'no-progress',
      noProgressTimeoutMs: 50,
    });
  });

  it('treats output directory file changes as progress for quiet long-running commands', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-output-progress-'));
    tempDirs.push(cwd);
    const outputDir = join(cwd, 'logs');
    mkdirSync(outputDir, { recursive: true });
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
          writeFileSync(join(outputDir, 'artifact-1.json'), '{"step":1}');
        }, 30);
        setTimeout(() => {
          writeFileSync(join(outputDir, 'artifact-2.json'), '{"step":2}');
        }, 70);
        setTimeout(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        }, 120);
        return child;
      },
    });
    const result = await gateway.run({
      command: { tool: 'node', args: ['write-artifacts.js'] },
      cwd,
      outputDir,
      timeoutMs: 1_000,
      noProgressTimeoutMs: 80,
      progressIntervalMs: 10,
      policy: {
        allow: [{ tool: 'node', args: [] }],
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
    const progress = JSON.parse(readFileSync(result.progressPath!, 'utf8')) as {
      lastOutputDirActivityAt: string | null;
      outputDirFileCount: number;
      outputDirBytes: number;
      outputDirLatestMtimeMs: number | null;
      timeoutReason: string | null;
    };
    expect(progress.lastOutputDirActivityAt).toEqual(expect.any(String));
    expect(progress.outputDirFileCount).toBe(2);
    expect(progress.outputDirBytes).toBeGreaterThan(0);
    expect(progress.outputDirLatestMtimeMs).toEqual(expect.any(Number));
    expect(progress.timeoutReason).toBeNull();
  });

  it('treats controlled artifact and manifest writes as no-progress activity', async () => {
    const cwd = mkdtempSync(
      join(tmpdir(), 'tekon-exec-output-artifact-progress-'),
    );
    tempDirs.push(cwd);
    const outputDir = join(cwd, 'logs');
    mkdirSync(outputDir, { recursive: true });
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
          writeFileSync(
            join(outputDir, 'artifact-manifest.json'),
            JSON.stringify({
              artifacts: [
                {
                  type: 'implementation-plan',
                  path: 'implementation-plan.json',
                  summary: 'Plan artifact.',
                },
              ],
            }),
          );
        }, 30);
        setTimeout(() => {
          writeFileSync(
            join(outputDir, 'implementation-plan.json'),
            JSON.stringify({
              title: 'Plan artifact',
              body: 'Plan body.',
            }),
          );
        }, 70);
        setTimeout(() => {
          child.stdout.end();
          child.stderr.end();
          child.emit('close', 0, null);
        }, 120);
        return child;
      },
    });

    const result = await gateway.run({
      command: { tool: 'node', args: ['write-tekon-artifacts.js'] },
      cwd,
      outputDir,
      timeoutMs: 1_000,
      noProgressTimeoutMs: 80,
      progressIntervalMs: 10,
      policy: {
        allow: [{ tool: 'node', args: [] }],
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
    const progress = JSON.parse(readFileSync(result.progressPath!, 'utf8')) as {
      lastOutputDirActivityAt: string | null;
      outputDirFileCount: number;
      outputDirBytes: number;
      outputDirLatestMtimeMs: number | null;
      timeoutReason: string | null;
    };
    expect(progress.lastOutputDirActivityAt).toEqual(expect.any(String));
    expect(progress.outputDirFileCount).toBe(2);
    expect(progress.outputDirBytes).toBeGreaterThan(0);
    expect(progress.outputDirLatestMtimeMs).toEqual(expect.any(Number));
    expect(progress.timeoutReason).toBeNull();
  });

  it('does not wait for the heartbeat interval before enforcing no-progress timeout', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-no-progress-fast-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: ['-e', 'setTimeout(() => {}, 5000)'],
      },
      cwd,
      outputDir: join(cwd, 'logs'),
      timeoutMs: 5_000,
      noProgressTimeoutMs: 50,
      progressIntervalMs: 1_000,
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        cwdScope: [cwd],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({
      status: 'executed',
      timedOut: true,
      timeoutReason: 'no-progress',
    });
    if (result.status !== 'executed') {
      throw new Error('expected command to execute');
    }
    expect(result.durationMs).toBeLessThan(500);
  });

  it('redacts likely secrets from progress command argv evidence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-progress-redact-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const fakeOpenAiKey = ['sk', '123456789012345678901234'].join('-');
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: ['-e', 'process.stdout.write("ok")', `token="${fakeOpenAiKey}"`],
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
    const progress = readFileSync(result.progressPath!, 'utf8');
    expect(progress).not.toContain(fakeOpenAiKey);
    expect(progress).toContain('[REDACTED_OPENAI_API_KEY]');
  });

  it('redacts common CLI secret argv forms from progress evidence', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-progress-redact-cli-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const tokenValue = 'abcdefghijklmnopqrstuvwxyz123456';
    const passwordValue = 'ZYXWVUTSRQPONMLKJIHGFEDCBA987654';
    const envValue = '0123456789abcdefghijklmnopqrstuv';
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: [
          '-e',
          'process.stdout.write("ok")',
          '--',
          `--token=${tokenValue}`,
          '--password',
          passwordValue,
          `GITHUB_TOKEN=${envValue}`,
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
    const progress = readFileSync(result.progressPath!, 'utf8');
    expect(progress).not.toContain(tokenValue);
    expect(progress).not.toContain(passwordValue);
    expect(progress).not.toContain(envValue);
    expect(progress).toContain('--token=[REDACTED_SECRET]');
    expect(progress).toContain('[REDACTED_SECRET]');
    expect(progress).toContain('GITHUB_TOKEN=[REDACTED_SECRET]');
  });

  it('allows shell-looking characters inside argv data values without invoking a shell', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-argv-data-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const argvData = 'PR title with <TEKON_OUTPUT_DIR> and `literal` $VALUE';
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: ['-e', 'process.stdout.write(process.argv[1])', argvData],
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
    expect(readFileSync(result.stdoutPath, 'utf8')).toBe(argvData);
  });

  it('redacts likely secrets from command stdout and stderr logs', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-redact-'));
    tempDirs.push(cwd);
    const gateway = createCommandGateway();
    const fakeOpenAiKey = ['sk', '123456789012345678901234'].join('-');
    const fakeGenericSecret = ['123456789012', '345678901234567890'].join('');
    const result = await gateway.run({
      command: {
        tool: process.execPath,
        args: [
          '-e',
          [
            `process.stdout.write('token = "${fakeOpenAiKey}"\\n')`,
            `process.stderr.write('secret = "${fakeGenericSecret}"\\n')`,
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
    expect(stdout).not.toContain(fakeOpenAiKey);
    expect(stderr).not.toContain(fakeGenericSecret);
    expect(stdout).toContain('[REDACTED_OPENAI_API_KEY]');
    expect(stderr).toContain('[REDACTED_SECRET]');
  });

  it('redacts likely secrets that are split across stdout and stderr chunks', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-exec-redact-chunks-'));
    tempDirs.push(cwd);
    const fakeOpenAiKey = ['sk', '123456789012345678901234'].join('-');
    const fakeGenericSecret = ['123456789012', '345678901234567890'].join('');
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
          child.stdout.write(`token = "${fakeOpenAiKey.slice(0, 13)}`);
          child.stdout.write(`${fakeOpenAiKey.slice(13)}"\n`);
          child.stderr.write(`secret = "${fakeGenericSecret.slice(0, 12)}`);
          child.stderr.write(`${fakeGenericSecret.slice(12)}"\n`);
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
    expect(stdout).not.toContain(fakeOpenAiKey);
    expect(stderr).not.toContain(fakeGenericSecret);
    expect(stdout).toContain('[REDACTED_OPENAI_API_KEY]');
    expect(stderr).toContain('[REDACTED_SECRET]');
  });

  it('closes child stdin without writing a chunk when no stdin is provided', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-stdin-close-'));
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
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-stdin-error-'));
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
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-no-stdin-epipe-'));
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
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-child-error-'));
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
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-log-error-'));
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
    const cwd = mkdtempSync(join(tmpdir(), 'tekon-timeout-hang-'));
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
    name: 'tekon',
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
