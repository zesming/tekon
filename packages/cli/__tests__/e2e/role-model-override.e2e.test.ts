import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createIsolatedBinDir,
  runCliWithEnv,
  writeFakeClaude,
} from '../helpers/fake-provider.js';

// PD-10 / TS-05：项目角色 agent.yaml 的 model 选择经真实 CLI 进程到达
// provider argv；effort 在 claude 上无法 honor 时显式失败（不静默丢弃）。
const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  roots.push(dir);
  return dir;
}

function fixtureRepo(repo: string) {
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@tekon.local'],
    ['config', 'user.name', 'Tekon Test'],
  ]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  writeFileSync(join(repo, 'README.md'), 'role override fixture\n');
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], {
    cwd: repo,
    stdio: 'pipe',
  });
}

function writeMinimalTemplate(repo: string) {
  mkdirSync(join(repo, '.tekon', 'workflows'), { recursive: true });
  writeFileSync(
    join(repo, '.tekon', 'workflows', 'role-model.yaml'),
    JSON.stringify({
      id: 'role-model',
      version: 1,
      phases: [
        {
          id: 'dev',
          name: 'Dev',
          dependsOn: [],
          nodes: [
            {
              id: 'rd-node',
              role: 'rd',
              inputs: [],
              outputs: [],
              gates: [],
              dependsOn: [],
            },
          ],
        },
      ],
    }),
  );
}

function writeProjectRole(repo: string, agentYaml: string) {
  const roleDir = join(repo, '.tekon', 'roles', 'rd');
  mkdirSync(roleDir, { recursive: true });
  writeFileSync(join(roleDir, 'agent.yaml'), agentYaml, 'utf8');
  writeFileSync(join(roleDir, 'system.md'), 'project rd system\n', 'utf8');
}

describe('PD-10 role model/effort through a real CLI process (TS-05)', () => {
  it('translates a project-role model into claude --model argv', () => {
    const repo = tempDir('tekon-role-model-repo-');
    fixtureRepo(repo);
    writeMinimalTemplate(repo);
    writeProjectRole(
      repo,
      ['role: rd', 'name: Project RD', 'model: claude-opts-5-5', ''].join('\n'),
    );

    const home = tempDir('tekon-role-model-home-');
    const binDir = createIsolatedBinDir();
    roots.push(binDir);
    const capture = join(binDir, 'calls.jsonl');
    writeFakeClaude(binDir, { behavior: 'success', captureFile: capture });

    const run = runCliWithEnv(
      cliPath,
      [
        'run',
        '角色模型真实进程',
        '--template',
        'role-model',
        '--agent',
        'claude-code',
        '--allow-dirty-base',
        '--repo',
        repo,
      ],
      {
        cwd: repo,
        binDirs: [binDir],
        isolatePath: true,
        home,
        timeoutMs: 120_000,
      },
    );
    expect(run.status, run.stdout + run.stderr).toBe(0);
    expect(existsSync(capture)).toBe(true);

    const invocations = readFileSync(capture, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { argv: string[] });
    const providerRun = invocations.find((entry) =>
      entry.argv.includes('--permission-mode'),
    );
    expect(providerRun, JSON.stringify(invocations)).toBeDefined();
    const argv = providerRun!.argv;
    expect(argv).toContain('--model');
    expect(argv[argv.indexOf('--model') + 1]).toBe('claude-opts-5-5');
  }, 180_000);

  it('fails the run when the role declares an effort claude cannot honor', () => {
    const repo = tempDir('tekon-role-effort-repo-');
    fixtureRepo(repo);
    writeMinimalTemplate(repo);
    writeProjectRole(
      repo,
      ['role: rd', 'name: Project RD', 'effort: high', ''].join('\n'),
    );

    const home = tempDir('tekon-role-effort-home-');
    const binDir = createIsolatedBinDir();
    roots.push(binDir);
    const capture = join(binDir, 'calls.jsonl');
    writeFakeClaude(binDir, { behavior: 'success', captureFile: capture });

    const run = runCliWithEnv(
      cliPath,
      [
        'run',
        '角色 effort 不支持',
        '--template',
        'role-model',
        '--agent',
        'claude-code',
        '--allow-dirty-base',
        '--repo',
        repo,
      ],
      {
        cwd: repo,
        binDirs: [binDir],
        isolatePath: true,
        home,
        timeoutMs: 120_000,
      },
    );
    // 节点在构建命令时被拦截，运行非零退出；fake provider 不被调用。
    expect(run.status).not.toBe(0);
    expect(run.stderr + run.stdout).toContain('ROLE_OVERRIDE_UNSUPPORTED');
    const providerRan =
      existsSync(capture) &&
      readFileSync(capture, 'utf8')
        .split('\n')
        .some((line) => line.includes('--permission-mode'));
    expect(providerRan).toBe(false);
  }, 180_000);
});
