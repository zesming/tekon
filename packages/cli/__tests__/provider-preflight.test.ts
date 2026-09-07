import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  DSH_NODE_REQUIREMENT,
  TESTED_DSH_VERSION,
  isHostNodeVersionCompatible,
} from '@tekon/core';

import { runCli, type CliIO } from '../src/index.js';
import { runDshPreflight } from '../src/commands/provider.js';
import {
  createFakeDsh,
  VALID_DSH_CONFIG,
} from './helpers/fake-dsh.js';

const VALID_HELP =
  'dsh headless --help\nprint the final assistant message on stdout';

function hostStatus(): '兼容' | '已旁路' {
  return isHostNodeVersionCompatible(process.versions.node)
    ? '兼容'
    : '已旁路';
}

function expectedAdmissionConclusion(): string {
  return isHostNodeVersionCompatible(process.versions.node)
    ? '兼容'
    : '已旁路（无合同保证）';
}

describe('tekon provider preflight', () => {
  const tempDirs: string[] = [];
  const anchorCwd = process.cwd();
  const originalPath = process.env.PATH;
  const originalAllowHostNode = process.env.TEKON_DSH_ALLOW_HOST_NODE;

  function admitCurrentHostForFixture(): void {
    if (!isHostNodeVersionCompatible(process.versions.node)) {
      process.env.TEKON_DSH_ALLOW_HOST_NODE = process.versions.node;
    }
  }

  afterEach(() => {
    try {
      process.chdir(anchorCwd);
    } catch {
      // ignore
    }
    process.env.PATH = originalPath;
    if (originalAllowHostNode === undefined) {
      delete process.env.TEKON_DSH_ALLOW_HOST_NODE;
    } else {
      process.env.TEKON_DSH_ALLOW_HOST_NODE = originalAllowHostNode;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('reports a successful admission when dsh version and contracts match', async () => {
    admitCurrentHostForFixture();
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: VALID_HELP,
      config: VALID_DSH_CONFIG,
    });
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    const io = createMemoryIo();

    const exitCode = await runCli(
      ['provider', 'preflight', 'dsh-headless'],
      io,
    );
    const stdout = io.takeStdout();

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`测试基准版本: ${TESTED_DSH_VERSION}`);
    expect(stdout).toContain(
      `当前检测版本: ${TESTED_DSH_VERSION} (已验证)`,
    );
    expect(stdout).toContain(
      `宿主 Node: ${process.versions.node} (${hostStatus()})`,
    );
    expect(stdout).toContain(`DSH Node 要求: ${DSH_NODE_REQUIREMENT}`);
    expect(stdout).toContain('Help 合同检查: 通过');
    expect(stdout).toContain('Config 合同检查: 通过');
    expect(stdout).toContain(
      `兼容性结论: ${expectedAdmissionConclusion()}`,
    );
  });

  it('reports the detected version when the version pin mismatches', async () => {
    admitCurrentHostForFixture();
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: '0.2.0-alpha',
      help: VALID_HELP,
      config: VALID_DSH_CONFIG,
    });
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    const io = createMemoryIo();

    const exitCode = await runCli(
      ['provider', 'preflight', 'dsh-headless'],
      io,
    );
    const stdout = io.takeStdout();

    expect(exitCode).toBe(1);
    expect(stdout).toContain('当前检测版本: 0.2.0-alpha (不兼容)');
    expect(stdout).toContain('兼容性结论: 不兼容');
  });

  it('reports not installed only when the version probe cannot run', async () => {
    admitCurrentHostForFixture();
    const emptyBinDir = mkdtempSync(join(tmpdir(), 'tekon-empty-bin-'));
    tempDirs.push(emptyBinDir);
    process.env.PATH = emptyBinDir;
    const io = createMemoryIo();

    const exitCode = await runCli(
      ['provider', 'preflight', 'dsh-headless'],
      io,
    );
    const stdout = io.takeStdout();

    expect(exitCode).toBe(1);
    expect(stdout).toContain('当前检测版本: 未安装或不可执行 (不兼容)');
    expect(stdout).toContain('兼容性结论: 不兼容');
  });

  it('keeps the detected version when help or config contract fails', async () => {
    admitCurrentHostForFixture();
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: 'broken help without anchor',
      config: 'missing required plugins',
    });
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    const io = createMemoryIo();

    const exitCode = await runCli(
      ['provider', 'preflight', 'dsh-headless'],
      io,
    );
    const stdout = io.takeStdout();

    expect(exitCode).toBe(1);
    expect(stdout).toContain(
      `当前检测版本: ${TESTED_DSH_VERSION} (已验证)`,
    );
    expect(stdout).not.toContain('当前检测版本: 未安装或不可执行');
    expect(stdout).toContain('Help 合同检查: 未通过');
    expect(stdout).toContain('Config 合同检查: 未通过');
  });

  it('outputs structured json for the actual host runtime', async () => {
    admitCurrentHostForFixture();
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: VALID_HELP,
      config: VALID_DSH_CONFIG,
    });
    process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ''}`;
    const io = createMemoryIo();

    const exitCode = await runCli(
      ['provider', 'preflight', 'dsh-headless', '--json'],
      io,
    );
    const parsed = JSON.parse(io.takeStdout());
    const compatible = isHostNodeVersionCompatible(process.versions.node);

    expect(exitCode).toBe(0);
    expect(parsed).toMatchObject({
      testedVersion: TESTED_DSH_VERSION,
      actualVersion: TESTED_DSH_VERSION,
      versionCompatible: true,
      versionBypassed: false,
      nodeRequirement: DSH_NODE_REQUIREMENT,
      helpContractOk: true,
      configContractOk: true,
      compatible: true,
      hostNodeVersion: process.versions.node,
      hostNodeCompatible: compatible,
      hostNodeBypassed: !compatible,
    });
    expect(parsed.installHint).not.toContain('Node');
  });

  it('keeps incompatible-host simulation in the programmatic seam', async () => {
    const result = await runDshPreflight({ hostNodeVersion: '20.19.0' });

    expect(result).toMatchObject({
      actualVersion: null,
      versionCompatible: false,
      versionBypassed: false,
      hostNodeVersion: '20.19.0',
      hostNodeCompatible: false,
      hostNodeBypassed: false,
      failureKind: 'host-node',
      compatible: false,
    });
  });

  it('admits an acknowledged stable host but does not relabel it compatible', async () => {
    const warnings: string[] = [];
    const result = await runDshPreflight({
      hostNodeVersion: '20.19.0',
      allowHostNode: '20.19.0',
      probeVersion: async () => `${TESTED_DSH_VERSION}\n`,
      probeHelp: async () => VALID_HELP,
      probeConfig: async () => VALID_DSH_CONFIG,
      onWarn: (warning) => warnings.push(warning),
    });

    expect(result).toMatchObject({
      versionCompatible: true,
      versionBypassed: false,
      hostNodeVersion: '20.19.0',
      hostNodeCompatible: false,
      hostNodeBypassed: true,
      compatible: true,
    });
    expect(warnings.join('\n')).toContain('TEKON_DSH_ALLOW_HOST_NODE');
  });

  it('does not expose the test-only host version override as a CLI option', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(
      [
        'provider',
        'preflight',
        'dsh-headless',
        '--host-node-version',
        '24.0.0',
      ],
      io,
    );

    expect(exitCode).toBe(1);
    expect(io.takeStderr()).toMatch(/host-node-version|unknown option/i);
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

  it('tekon help provider displays the preflight subcommand', async () => {
    const io = createMemoryIo();
    const exitCode = await runCli(['help', 'provider'], io);
    expect(exitCode).toBe(0);
    expect(io.takeStdout()).toContain('preflight');
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
