import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  DSH_NODE_REQUIREMENT,
  TESTED_DSH_VERSION,
} from '@tekon/core';

import { runCli, type CliIO } from '../src/index.js';
import { runDshPreflight } from '../src/commands/provider.js';
import {
  createFakeDsh,
  VALID_DSH_CONFIG,
} from './helpers/fake-dsh.js';

describe('tekon provider preflight', () => {
  const tempDirs: string[] = [];
  const anchorCwd = process.cwd();

  afterEach(() => {
    try {
      process.chdir(anchorCwd);
    } catch {
      // ignore
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('reports compatible exit 0 when dsh version and contracts match', async () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: 'dsh headless --help\nprint the final assistant message on stdout',
      config: VALID_DSH_CONFIG,
    });

    const io = createMemoryIo();
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    try {
      const exitCode = await runCli(
        ['provider', 'preflight', 'dsh-headless'],
        io,
      );
      const stdout = io.takeStdout();

      expect(exitCode).toBe(0);
      expect(stdout).toContain(`测试基准版本: ${TESTED_DSH_VERSION}`);
      expect(stdout).toContain(`当前检测版本: ${TESTED_DSH_VERSION}`);
      expect(stdout).toContain(`DSH Node 要求: ${DSH_NODE_REQUIREMENT}`);
      expect(stdout).toContain('Help 合同检查: 通过');
      expect(stdout).toContain('Config 合同检查: 通过');
      expect(stdout).toContain('兼容性结论: 兼容');
      expect(stdout).toContain(
        `安装指引: npm install -g @deepseek-ai/dsh@${TESTED_DSH_VERSION}`,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('reports incompatible exit 1 when dsh version mismatches', async () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: '0.2.0-alpha',
      help: 'print the final assistant message',
      config: VALID_DSH_CONFIG,
    });

    const io = createMemoryIo();
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    try {
      const exitCode = await runCli(
        ['provider', 'preflight', 'dsh-headless'],
        io,
      );
      const stdout = io.takeStdout();

      expect(exitCode).toBe(1);
      expect(stdout).toContain(`测试基准版本: ${TESTED_DSH_VERSION}`);
      expect(stdout).toContain('当前检测版本: 0.2.0-alpha');
      expect(stdout).toContain(`DSH Node 要求: ${DSH_NODE_REQUIREMENT}`);
      expect(stdout).toContain('兼容性结论: 不兼容');
      expect(stdout).toContain(
        `安装指引: npm install -g @deepseek-ai/dsh@${TESTED_DSH_VERSION}`,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('reports incompatible exit 1 when dsh binary is not found', async () => {
    const emptyBinDir = mkdtempSync(join(tmpdir(), 'tekon-empty-bin-'));
    tempDirs.push(emptyBinDir);

    const io = createMemoryIo();
    const originalPath = process.env.PATH;
    process.env.PATH = emptyBinDir;
    try {
      const exitCode = await runCli(
        ['provider', 'preflight', 'dsh-headless'],
        io,
      );
      const stdout = io.takeStdout();

      expect(exitCode).toBe(1);
      expect(stdout).toContain(`测试基准版本: ${TESTED_DSH_VERSION}`);
      expect(stdout).toContain('当前检测版本: 未安装或不可执行');
      expect(stdout).toContain(`DSH Node 要求: ${DSH_NODE_REQUIREMENT}`);
      expect(stdout).toContain('兼容性结论: 不兼容');
      expect(stdout).toContain(
        `安装指引: npm install -g @deepseek-ai/dsh@${TESTED_DSH_VERSION}`,
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('keeps the detected version when help or config contract fails', async () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: 'broken help without anchor',
      config: 'missing required plugins',
    });

    const io = createMemoryIo();
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    try {
      const exitCode = await runCli(
        ['provider', 'preflight', 'dsh-headless'],
        io,
      );
      const stdout = io.takeStdout();

      expect(exitCode).toBe(1);
      expect(stdout).toContain(`当前检测版本: ${TESTED_DSH_VERSION}`);
      expect(stdout).not.toContain('当前检测版本: 未安装或不可执行');
      expect(stdout).toContain('Help 合同检查: 未通过');
      expect(stdout).toContain('Config 合同检查: 未通过');
      expect(stdout).toContain('兼容性结论: 不兼容');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('outputs structured json when --json is provided', async () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: 'print the final assistant message',
      config: VALID_DSH_CONFIG,
    });

    const io = createMemoryIo();
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    try {
      const exitCode = await runCli(
        ['provider', 'preflight', 'dsh-headless', '--json'],
        io,
      );
      const stdout = io.takeStdout();

      expect(exitCode).toBe(0);
      const parsed = JSON.parse(stdout);
      expect(parsed).toMatchObject({
        testedVersion: TESTED_DSH_VERSION,
        actualVersion: TESTED_DSH_VERSION,
        nodeRequirement: DSH_NODE_REQUIREMENT,
        helpContractOk: true,
        configContractOk: true,
        compatible: true,
        installHint: `npm install -g @deepseek-ai/dsh@${TESTED_DSH_VERSION}`,
      });
      expect(parsed.installHint).not.toContain('Node');
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it('rejects unsupported provider name', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(
      ['provider', 'preflight', 'some-unknown-provider'],
      io,
    );
    expect(exitCode).toBe(1);
    expect(io.takeStderr()).toContain(
      "暂不支持对 Provider 'some-unknown-provider' 进行预检",
    );
  });

  it('rejects provider command without subcommands', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['provider'], io);
    expect(exitCode).toBe(1);
    expect(io.takeStderr()).toContain('请指定子命令');
  });

  it('tekon help provider displays subcommand list', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['help', 'provider'], io);
    expect(exitCode).toBe(0);
    const stdout = io.takeStdout();
    expect(stdout).toContain('tekon provider');
    expect(stdout).toContain('preflight');
  });
});

function createMemoryIo(): CliIO & {
  takeStdout(): string;
  takeStderr(): string;
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: { write: (chunk) => void (stdout += chunk) },
    stderr: { write: (chunk) => void (stderr += chunk) },
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
