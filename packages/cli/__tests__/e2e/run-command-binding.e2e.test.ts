import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openTekonDatabase, projectRunPlan, loadWorkflowTemplate, canonicalJson } from '@tekon/core';
import { afterEach, describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function run(repo: string, args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--repo', repo], {
    cwd: repo, encoding: 'utf8', timeout: 20_000,
  });
  expect(result.error).toBeUndefined();
  return result;
}
function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'tekon-cli-binding-'));
  roots.push(repo);
  for (const args of [['init', '-b', 'main'], ['config', 'user.email', 'test@tekon.local'], ['config', 'user.name', 'Tekon Test']]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ scripts: { confirmed: 'node -e "process.exit(0)"' } }));
  execFileSync('git', ['add', 'package.json'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], { cwd: repo, stdio: 'pipe' });
  expect(run(repo, ['init']).status).toBe(0);
  writeFileSync(join(repo, '.tekon', 'workflows', 'binding.yaml'), JSON.stringify({
    id: 'binding', governance: 'none', phases: [{ id: 'dev', nodes: [{
      id: 'developer', role: 'rd', gates: [{ type: 'build', commandRef: 'build' }],
    }] }],
  }));
  const profile = join(repo, '.tekon', 'repo-profile.yaml');
  writeFileSync(profile, 'version: 1\ncommands:\n  build:\n    tool: npm\n    args: [run, confirmed]\n');
  return { repo, profile };
}

describe('R24 CLI 真进程命令绑定与历史观察', () => {
  it('新受理持久化v3和有效命令，坏配置不阻止原requestId重放，status输出frozen', () => {
    const { repo, profile } = fixture();
    const args = ['run', '真实CLI冻结命令', '--template', 'binding', '--agent', 'mock', '--allow-dirty-base', '--request-id', 'cli-binding-01'];
    const first = run(repo, args);
    expect(first.status, first.stderr).toBe(0);
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(first.stdout)?.[1];
    expect(runId).toBeTruthy();
    const db = openTekonDatabase({ filename: join(repo, '.tekon', 'tekon.sqlite') });
    try {
      const row = db.prepare('select plan_snapshot from workflow_instances where id=?').get(runId) as { plan_snapshot: string };
      expect(JSON.parse(row.plan_snapshot)).toMatchObject({ digestVersion: 3, repoCommands: [expect.objectContaining({ commandRef: 'build', status: 'resolved' })] });
      const node = db.prepare('select gates from nodes where run_id=?').get(runId) as { gates: string };
      expect(JSON.parse(node.gates)[0]).toMatchObject({ command: { tool: 'npm', args: ['run', 'confirmed'] } });
      expect(JSON.parse(node.gates)[0]).not.toHaveProperty('commandRef');
    } finally { db.close(); }
    writeFileSync(profile, '[PRIVATE_BROKEN_PROFILE');
    const replay = run(repo, args);
    expect(replay.status, replay.stderr).toBe(0);
    expect(replay.stdout).toContain(runId!);
    const status = run(repo, ['status', '--run-id', runId!]);
    expect(status.status, status.stderr).toBe(0);
    expect(status.stdout).toContain('executionBinding=frozen');
    expect(status.stderr).not.toContain('PRIVATE_BROKEN_PROFILE');
  }, 60_000);

  it('status区分历史v2、缺损admission及未知版本，并将解释留在stderr', () => {
    const { repo } = fixture();
    const started = run(repo, ['run', '历史观察', '--goal', '--agent', 'mock', '--allow-dirty-base']);
    expect(started.status, started.stderr).toBe(0);
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(started.stdout)?.[1];
    expect(runId).toBeTruthy();
    const db = openTekonDatabase({ filename: join(repo, '.tekon', 'tekon.sqlite') });
    try {
      const legacy = projectRunPlan(loadWorkflowTemplate({ name: 'goal' }), { agent: 'mock', mode: 'goal' });
      db.prepare('update workflow_instances set plan_snapshot=?,plan_digest=? where id=?').run(canonicalJson(legacy), legacy.digest, runId);
      const old = run(repo, ['status', '--run-id', runId!]);
      expect(old.status, old.stderr).toBe(0);
      expect(old.stdout).toContain('executionBinding=legacy-unbound');
      expect(old.stderr).toContain('历史计划未记录仓库命令绑定');
      expect(old.stderr).toContain('commandRef');
      db.prepare('update workflow_instances set plan_snapshot=null,plan_digest=null where id=?').run(runId);
      const invalid = run(repo, ['status', '--run-id', runId!]);
      expect(invalid.stdout).toContain('executionBinding=invalid');
      expect(invalid.stderr).toContain('校验失败');
      db.prepare('update workflow_instances set plan_snapshot=?,plan_digest=? where id=?').run('{"digestVersion":999}', 'unknown', runId);
      const unknown = run(repo, ['status', '--run-id', runId!]);
      expect(unknown.stdout).toContain('executionBinding=unknown');
      expect(unknown.stderr).toContain('待确认');
    } finally { db.close(); }
  }, 45_000);
});
