import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import {
  DSH_NODE_REQUIREMENT,
  TESTED_DSH_VERSION,
  isHostNodeVersionCompatible,
} from '@tekon/core';

import {
  createFakeDsh,
  VALID_DSH_CONFIG,
} from '../helpers/fake-dsh.js';

describe('tekon provider preflight e2e', () => {
  const tempDirs: string[] = [];
  const cliPackageRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  const originalAllowHostNode = process.env.TEKON_DSH_ALLOW_HOST_NODE;

  afterEach(() => {
    if (originalAllowHostNode === undefined) {
      delete process.env.TEKON_DSH_ALLOW_HOST_NODE;
    } else {
      process.env.TEKON_DSH_ALLOW_HOST_NODE = originalAllowHostNode;
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function fixtureEnv(fakeBinDir: string): NodeJS.ProcessEnv {
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
    };
    if (!isHostNodeVersionCompatible(process.versions.node)) {
      env.TEKON_DSH_ALLOW_HOST_NODE = process.versions.node;
    }
    return env;
  }

  function createMatchingFake(): string {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-e2e-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: 'dsh headless --help\nprint the final assistant message on stdout',
      config: VALID_DSH_CONFIG,
    });
    return fakeBinDir;
  }

  it('runs preflight against a matching fake dsh in PATH', () => {
    const fakeBinDir = createMatchingFake();
    const cliPath = join(cliPackageRoot, 'dist', 'index.js');
    const output = execFileSync(
      process.execPath,
      [cliPath, 'provider', 'preflight', 'dsh-headless'],
      { encoding: 'utf8', env: fixtureEnv(fakeBinDir) },
    );

    const hostCompatible = isHostNodeVersionCompatible(process.versions.node);
    const status = hostCompatible ? '兼容' : '已旁路';
    const conclusion = hostCompatible
      ? '兼容'
      : '已旁路（无合同保证）';
    expect(output).toContain(`测试基准版本: ${TESTED_DSH_VERSION}`);
    expect(output).toContain(
      `当前检测版本: ${TESTED_DSH_VERSION} (已验证)`,
    );
    expect(output).toContain(`宿主 Node: ${process.versions.node} (${status})`);
    expect(output).toContain(`DSH Node 要求: ${DSH_NODE_REQUIREMENT}`);
    expect(output).toContain('Help 合同检查: 通过');
    expect(output).toContain('Config 合同检查: 通过');
    expect(output).toContain(`兼容性结论: ${conclusion}`);
  });

  it('returns parseable JSON describing tested compatibility and admission', () => {
    const fakeBinDir = createMatchingFake();
    const cliPath = join(cliPackageRoot, 'dist', 'index.js');
    const output = execFileSync(
      process.execPath,
      [cliPath, 'provider', 'preflight', 'dsh-headless', '--json'],
      { encoding: 'utf8', env: fixtureEnv(fakeBinDir) },
    );

    const parsed = JSON.parse(output);
    const compatible = isHostNodeVersionCompatible(process.versions.node);
    expect(parsed).toMatchObject({
      testedVersion: TESTED_DSH_VERSION,
      actualVersion: TESTED_DSH_VERSION,
      versionCompatible: true,
      versionBypassed: false,
      nodeRequirement: DSH_NODE_REQUIREMENT,
      hostNodeVersion: process.versions.node,
      hostNodeCompatible: compatible,
      hostNodeBypassed: !compatible,
      compatible: true,
    });
  });

  it('rejects the former public host-version injection option', () => {
    const cliPath = join(cliPackageRoot, 'dist', 'index.js');
    const result = spawnSync(
      process.execPath,
      [
        cliPath,
        'provider',
        'preflight',
        'dsh-headless',
        '--host-node-version',
        '24.0.0',
      ],
      { encoding: 'utf8' },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/host-node-version|unknown option/i);
  });

  it('shows the provider preflight help entry', () => {
    const cliPath = join(cliPackageRoot, 'dist', 'index.js');
    const output = execFileSync(
      process.execPath,
      [cliPath, 'help', 'provider'],
      { encoding: 'utf8' },
    );
    expect(output).toContain('tekon provider');
    expect(output).toContain('preflight');
  });
});
