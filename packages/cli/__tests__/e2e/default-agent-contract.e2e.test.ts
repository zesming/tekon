import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { openTekonDatabase } from '@tekon/core';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createIsolatedBinDir,
  runCliWithEnv,
  writeFakeClaude,
  writeFakeCodex,
} from '../helpers/fake-provider.js';

// TS-02 / contract 1: the default-agent path (no `--agent`) previously had no
// regression protection — mutating the default resolver or the failure
// diagnostics stayed green. These real-process tests drive `tekon run` without
// an explicit agent through missing-provider and unauthenticated failures,
// plus the codex symmetry and the rework-stage audit diagnostic.
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

function fixtureRepo(): string {
  const repo = tempDir('tekon-default-agent-');
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
        // bugfix runs build/lint/security (rd) and test (qa) command gates;
        // every gate must resolve so the run reaches the reviewer human gate.
        build: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        security: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
    }),
  );
  execFileSync('git', ['add', '.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
  return repo;
}

function makeCli(repo: string, binDir: string, home: string) {
  return (args: string[]) =>
    runCliWithEnv(cliPath, [...args, '--repo', repo], {
      cwd: repo,
      binDirs: [binDir],
      isolatePath: true,
      home,
      timeoutMs: 120_000,
    });
}

function runCount(repo: string): number {
  const dbPath = join(repo, '.tekon', 'tekon.sqlite');
  if (!existsSync(dbPath)) return 0;
  const db = openTekonDatabase({ filename: dbPath });
  try {
    return (db.prepare('select count(*) as count from workflow_instances').get() as { count: number })
      .count;
  } finally {
    db.close();
  }
}

function setDefaultAgent(repo: string, agent: string): void {
  writeFileSync(join(repo, '.tekon', 'config.yaml'), `defaultAgent: ${agent}\n`);
}

describe('default-agent contract through a real CLI process (TS-02)', () => {
  it('fails before starting when the configured default provider is not installed', () => {
    const repo = fixtureRepo();
    const home = tempDir('tekon-default-agent-home-');
    const binDir = createIsolatedBinDir();
    roots.push(binDir);
    const cli = makeCli(repo, binDir, home);
    expect(cli(['init']).status).toBe(0);
    // init pins the fallback default agent; the isolated PATH has no claude.
    expect(readFileSync(join(repo, '.tekon', 'config.yaml'), 'utf8')).toContain(
      'defaultAgent: claude-code',
    );

    const result = cli(['run', '修复默认路径的按钮文案', '--template', 'bugfix']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('找不到 claude 命令');
    expect(result.stderr).toContain('下一步: 安装 claude');
    expect(result.stderr).not.toContain('tekon resume');
    expect(runCount(repo)).toBe(0);
  }, 150_000);

  it('surfaces the login reason on the default path without suggesting resume', () => {
    const repo = fixtureRepo();
    const home = tempDir('tekon-default-agent-home-');
    const binDir = createIsolatedBinDir();
    roots.push(binDir);
    writeFakeClaude(binDir, {
      behavior: 'not-authenticated',
      auth: { loggedIn: false },
    });
    const cli = makeCli(repo, binDir, home);
    expect(cli(['init']).status).toBe(0);

    const run = cli(['run', '修复默认路径的登录失败', '--template', 'bugfix']);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain('⚠ 运行中断');
    expect(run.stdout).toContain('原因: claude 未登录或凭据无效');
    expect(run.stdout).toMatch(/下一步: 执行 claude auth login/u);
    // A login failure cannot be fixed by retrying the same snapshot.
    expect(run.stderr).not.toContain('tekon resume');
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(run.stdout)?.[1];
    expect(runId).toBeTruthy();

    const status = cli(['status', '--run-id', runId!]);
    expect(status.stdout).toContain('status=interrupted');
    expect(status.stdout).toContain('原因: claude 未登录或凭据无效');
  }, 180_000);

  it('keeps the missing-provider diagnostics symmetric for a codex default', () => {
    const repo = fixtureRepo();
    const home = tempDir('tekon-default-agent-home-');
    const binDir = createIsolatedBinDir();
    roots.push(binDir);
    const cli = makeCli(repo, binDir, home);
    expect(cli(['init']).status).toBe(0);
    setDefaultAgent(repo, 'codex');

    const missing = cli(['run', 'codex 默认路径未安装', '--template', 'bugfix']);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain('找不到 codex 命令');
    expect(missing.stderr).toContain('下一步: 安装 codex');
    expect(runCount(repo)).toBe(0);

    writeFakeCodex(binDir, { behavior: 'not-authenticated' });
    const unauth = cli(['run', 'codex 默认路径未登录', '--template', 'bugfix']);
    expect(unauth.status).toBe(1);
    expect(unauth.stdout).toContain('原因: codex 未登录或凭据无效');
    expect(unauth.stderr).not.toContain('tekon resume');
  }, 180_000);

  it('records the not-authenticated diagnostic on a later node after a human gate', () => {
    const repo = fixtureRepo();
    const home = tempDir('tekon-default-agent-home-');
    const binDir = createIsolatedBinDir();
    roots.push(binDir);
    writeFakeClaude(binDir, { behavior: 'success' });
    const cli = makeCli(repo, binDir, home);
    expect(cli(['init']).status).toBe(0);
    // Three nodes across phases: the human gate is evaluated after its node
    // executes, so the provider failure must happen on a node that starts only
    // after approval. No command gates: the isolated PATH has node+git only.
    writeFileSync(
      join(repo, '.tekon', 'workflows', 'rework-auth.yaml'),
      [
        'id: rework-auth',
        'governance: none',
        'phases:',
        '  - id: dev',
        '    nodes:',
        '      - id: first-pass',
        '        role: rd',
        '        outputs:',
        '          - review:review-report',
        '        gates:',
        '          - type: schema',
        '            artifactType: review-report',
        '  - id: gate',
        '    dependsOn:',
        '      - dev',
        '    nodes:',
        '      - id: human-gated',
        '        role: qa',
        '        outputs:',
        '          - qa:qa-release-signoff',
        '        gates:',
        '          - type: human',
        '            requiresHumanApproval: true',
        '  - id: rework',
        '    dependsOn:',
        '      - gate',
        '    nodes:',
        '      - id: after-approval',
        '        role: reviewer',
        '        outputs:',
        '          - test:test-report',
        '        gates:',
        '          - type: schema',
        '            artifactType: test-report',
        '',
      ].join('\n'),
    );

    // The first node passes with a working provider; the run pauses at the
    // human gate before the rework node executes.
    const first = cli([
      'run', '返工阶段才出现登录失效', '--template', 'rework-auth', '--agent', 'claude-code',
    ]);
    expect(first.status, first.stdout + first.stderr).toBe(0);
    expect(first.stdout).toContain('运行已暂停，等待人工确认');
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(first.stdout)?.[1];
    expect(runId).toBeTruthy();
    {
      const dbg = openTekonDatabase({ filename: join(repo, '.tekon', 'tekon.sqlite') });
      try {
        const decisions = dbg
          .prepare('select status from human_decisions where run_id=?')
          .all(runId) as Array<{ status: string }>;
        expect(decisions).toContainEqual({ status: 'pending' });
      } finally {
        dbg.close();
      }
    }

    // Swap the provider in place: the same PATH entry now refuses login.
    writeFakeClaude(binDir, {
      behavior: 'not-authenticated',
      auth: { loggedIn: false },
    });
    const resume = cli(['resume', '--run-id', runId!, '--approve-human']);
    expect(resume.status).toBe(1);
    expect(`${resume.stdout}${resume.stderr}`).toContain('原因: claude 未登录或凭据无效');

    const db = openTekonDatabase({
      filename: join(repo, '.tekon', 'tekon.sqlite'),
    });
    try {
      // An agent failure on the post-approval node is recorded on
      // node.interrupted with the structured diagnostic (gate.execution.error
      // is reserved for command-gate execution failures, which never run here).
      const rows = db
        .prepare(
          "select payload from audit_events where run_id = ? and type = 'node.interrupted' order by id",
        )
        .all(runId) as Array<{ payload: string }>;
      expect(rows.length).toBeGreaterThan(0);
      const diagnostics = rows.map((row) =>
        (JSON.parse(row.payload) as { diagnostic?: { code?: string } }).diagnostic?.code,
      );
      expect(diagnostics).toContain('not-authenticated');
    } finally {
      db.close();
    }
  }, 240_000);
});
