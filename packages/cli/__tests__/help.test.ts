import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { runCli, type CliIO } from '../src/index.js';

function createMemoryIo(): CliIO & {
  takeStdout(): string;
  takeStderr(): string;
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
    takeStdout() {
      const value = stdout;
      stdout = '';
      return value;
    },
    takeStderr() {
      const value = stderr;
      stderr = '';
      return value;
    },
  };
}

function readRootVersion(): string {
  const pkg = JSON.parse(
    readFileSync(new URL('../../../package.json', import.meta.url), 'utf8'),
  ) as { version: string };
  return pkg.version;
}

describe('tekon help', () => {
  it('tekon help shows human-first entry points before the full command inventory', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['help'], io);
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('推荐开始方式');
    expect(stdout).toContain('tekon ui');
    expect(stdout).toContain('tekon run "你的需求"');
    expect(stdout).toContain('全部命令');
    expect(stdout.indexOf('推荐开始方式')).toBeLessThan(
      stdout.indexOf('项目管理'),
    );
  });

  it('tekon help shows all commands grouped by category with Chinese descriptions', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['help'], io);
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);

    // Group names
    expect(stdout).toContain('项目管理');
    expect(stdout).toContain('运行控制');
    expect(stdout).toContain('工作流与角色');
    expect(stdout).toContain('交付');
    expect(stdout).toContain('审阅与评估');
    expect(stdout).toContain('工具');

    // Key commands
    expect(stdout).toContain('init');
    expect(stdout).toContain('draft');
    expect(stdout).toContain('run');
    expect(stdout).toContain('status');
    expect(stdout).toContain('clean');
    expect(stdout).toContain('ui');
    expect(stdout).toContain('update');

    // Chinese descriptions
    expect(stdout).toContain('初始化');
    expect(stdout).toContain('需求草案');
    expect(stdout).toContain('工作流');
    expect(stdout).toContain('角色');
    expect(stdout).toContain('约束');
    expect(stdout).toContain('交付');
    expect(stdout).toContain('审批');
    expect(stdout).toContain('评估');
    expect(stdout).toContain('审阅');
    expect(stdout).toContain('审计');
    expect(stdout).toContain('清理');
    expect(stdout).toContain('Web');
    expect(stdout).toContain('更新');
  });

  it('tekon --help produces same output as tekon help', async () => {
    const io1 = createMemoryIo();
    await runCli(['help'], io1);
    const stdout1 = io1.takeStdout();

    const io2 = createMemoryIo();
    await runCli(['--help'], io2);
    const stdout2 = io2.takeStdout();

    expect(stdout2).toBe(stdout1);
  });

  it('tekon -h produces same output as tekon help', async () => {
    const io1 = createMemoryIo();
    await runCli(['help'], io1);
    const stdout1 = io1.takeStdout();

    const io2 = createMemoryIo();
    await runCli(['-h'], io2);
    const stdout2 = io2.takeStdout();

    expect(stdout2).toBe(stdout1);
  });

  it('tekon --version outputs the root product version', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['--version'], io);
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);
    expect(stdout).toBe(`v${readRootVersion()}\n`);
  });

  it('tekon -v outputs the root product version', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['-v'], io);
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);
    expect(stdout).toBe(`v${readRootVersion()}\n`);
  });

  it('tekon help <command> shows subcommands and usage', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['help', 'draft'], io);
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('new');
    expect(stdout).toContain('shape');
    expect(stdout).toContain('approve');
    expect(stdout).toContain('show');
    expect(stdout).toContain('需求草案');
  });

  it('tekon help workflow shows workflow subcommands', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['help', 'workflow'], io);
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('list');
    expect(stdout).toContain('show');
    expect(stdout).toContain('create');
    expect(stdout).toContain('select');
    expect(stdout).toContain('preflight');
  });

  it('tekon help <nonexistent> shows error on stderr', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['help', 'nonexistent_cmd'], io);
    const stdout = io.takeStdout();
    const stderr = io.takeStderr();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('未知命令');
    expect(stdout).toBe('');
  });

  it('tekon with no args shows the same human-first help as tekon help', async () => {
    const helpIo = createMemoryIo();
    await runCli(['help'], helpIo);
    const expected = helpIo.takeStdout();

    const io = createMemoryIo();
    const exitCode = await runCli([], io);
    const stdout = io.takeStdout();
    const stderr = io.takeStderr();

    expect(exitCode).toBe(0);
    expect(stdout).toBe(expected);
    expect(stderr).toBe('');
  });

  it('tekon <unknown> shows guided error on stderr', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['nonexistent_cmd'], io);
    const stdout = io.takeStdout();
    const stderr = io.takeStderr();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('未知命令');
    expect(stderr).toContain('tekon help');
    expect(stdout).toBe('');
  });

  it('tekon help --help shows help self-description', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['help', '--help'], io);
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);
    expect(stdout).toContain('tekon help');
  });

  it('tekon help output contains the root product version', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['help'], io);
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Tekon CLI v${readRootVersion()}`);
  });

  it('tekon workflow list lists built-in workflow template ids sorted one per line', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['workflow', 'list'], io);
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);
    const lines = stdout.trim().split('\n');
    expect(lines).toEqual([
      'bugfix',
      'docs-update',
      'goal',
      'plan-only',
      'standard-delivery',
      'standard-feature',
      'test-improvement',
    ]);
  });

});
