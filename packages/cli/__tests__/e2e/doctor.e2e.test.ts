import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createIsolatedBinDir,
  runCliWithEnv,
  writeFakeClaude,
} from '../helpers/fake-provider.js';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function setup() {
  const repo = tempDir('tekon-doctor-');
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@tekon.local'],
    ['config', 'user.name', 'Tekon Test'],
  ]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  writeFileSync(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      scripts: {
        build: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
        typecheck: 'node -e "process.exit(0)"',
      },
    }),
  );
  const home = tempDir('tekon-doctor-home-');
  const binDir = createIsolatedBinDir();
  roots.push(binDir);
  const cli = (args: string[]) =>
    runCliWithEnv(cliPath, [...args, '--repo', repo], {
      cwd: repo,
      binDirs: [binDir],
      isolatePath: true,
      home,
    });
  return { repo, binDir, cli };
}

describe('tekon doctor and init provider selection', () => {
  it('reports a missing default provider and says what to do', () => {
    const { cli } = setup();
    const init = cli(['init']);
    expect(init.status).toBe(0);
    expect(init.stdout).toContain('未找到已安装的 claude 或 codex，运行 tekon doctor');

    const doctor = cli(['doctor']);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain('claude-code: 未安装（PATH 里没有 claude）（默认）');
    expect(doctor.stdout).toContain('codex: 未安装');
    expect(doctor.stdout).toContain('结论: 运行前需要处理');
    expect(doctor.stdout).toContain('默认 agent claude-code 未安装');
  });

  it('picks the installed provider at init and shows how it authenticates', () => {
    const { repo, binDir, cli } = setup();
    writeFakeClaude(binDir, { version: '9.9.9 (Claude Code)' });
    expect(cli(['init']).stdout).toContain('默认 agent: claude-code');
    expect(readFileSync(join(repo, '.tekon', 'config.yaml'), 'utf8')).toBe(
      'defaultAgent: claude-code\n',
    );

    const doctor = cli(['doctor']);
    expect(doctor.stdout).toContain(
      'claude-code: 已安装 9.9.9 (Claude Code)，认证方式: 订阅登录（默认）',
    );
    // Identity fields from `auth status` are never printed.
    expect(doctor.stdout).not.toContain('fake-user@example.invalid');
    expect(doctor.stdout).not.toContain('默认 agent claude-code 未');
    expect(doctor.stdout).toContain('结论: 可以开始运行');
    expect(doctor.status).toBe(0);
  });

  it('keeps an existing config and flags an old default that is not installed', () => {
    const { repo, cli } = setup();
    mkdirSync(join(repo, '.tekon'), { recursive: true });
    const legacy = 'project:\n  name: fixture\nstorage:\n  dataDir: .tekon\ndefaultAgent: codex\n';
    writeFileSync(join(repo, '.tekon', 'config.yaml'), legacy);

    const init = cli(['init']);
    expect(init.stdout).toContain('配置: 保留已有的 .tekon/config.yaml');
    expect(readFileSync(join(repo, '.tekon', 'config.yaml'), 'utf8')).toBe(legacy);

    const doctor = cli(['doctor']);
    expect(doctor.status).toBe(1);
    expect(doctor.stdout).toContain('codex: 未安装（PATH 里没有 codex）（默认）');
    expect(doctor.stdout).toContain('修改 .tekon/config.yaml 的 defaultAgent，或运行时加 --agent');
  });
});
