import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { TESTED_DSH_VERSION } from '@tekon/core';

describe('tekon provider preflight e2e', () => {
  const tempDirs: string[] = [];
  const cliPackageRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('runs provider preflight dsh-headless against a matching fake dsh in PATH', () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-e2e-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: 'dsh headless --help\nprint the final assistant message on stdout',
      config:
        '{"plugins":["headless-runner","sandbox-policy","user-approval","session-persistence-jsonl","agent-default-model"]}',
    });

    const cliPath = join(cliPackageRoot, 'dist', 'index.js');
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
    };

    const output = execFileSync(
      process.execPath,
      [cliPath, 'provider', 'preflight', 'dsh-headless'],
      { encoding: 'utf8', env },
    );

    expect(output).toContain(`测试基准版本: ${TESTED_DSH_VERSION}`);
    expect(output).toContain(`当前检测版本: ${TESTED_DSH_VERSION}`);
    expect(output).toContain('Help 合同检查: 通过');
    expect(output).toContain('Config 合同检查: 通过');
    expect(output).toContain('兼容性结论: 兼容');
    expect(output).toMatch(
      new RegExp(
        `npm (?:install|i) -g @deepseek-ai/dsh@${TESTED_DSH_VERSION.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
      ),
    );
  });

  it('runs provider preflight dsh-headless --json returning parseable JSON', () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), 'tekon-e2e-fake-dsh-'));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: 'print the final assistant message',
      config:
        'headless-runner sandbox-policy user-approval session-persistence-jsonl agent-default-model',
    });

    const cliPath = join(cliPackageRoot, 'dist', 'index.js');
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ''}`,
    };

    const output = execFileSync(
      process.execPath,
      [cliPath, 'provider', 'preflight', 'dsh-headless', '--json'],
      { encoding: 'utf8', env },
    );

    const parsed = JSON.parse(output);
    expect(parsed.testedVersion).toBe(TESTED_DSH_VERSION);
    expect(parsed.actualVersion).toBe(TESTED_DSH_VERSION);
    expect(parsed.helpContractOk).toBe(true);
    expect(parsed.configContractOk).toBe(true);
    expect(parsed.compatible).toBe(true);
  });

  it('runs help provider showing preflight subcommand', () => {
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

function createFakeDsh(
  dir: string,
  opts: { version: string; help: string; config: string },
) {
  const scriptPath = join(dir, 'dsh');
  const content = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) {
  process.stdout.write(${JSON.stringify(opts.version + '\n')});
  process.exit(0);
}
if (args.includes('--help')) {
  process.stdout.write(${JSON.stringify(opts.help + '\n')});
  process.exit(0);
}
if (args.includes('--dump-default-config')) {
  process.stdout.write(${JSON.stringify(opts.config + '\n')});
  process.exit(0);
}
process.exit(0);
`;
  writeFileSync(scriptPath, content, { mode: 0o755 });
}
