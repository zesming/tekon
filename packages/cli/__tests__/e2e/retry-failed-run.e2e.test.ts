import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';
import { openTekonDatabase } from '@tekon/core';

// PD-17 步 3：failed 运行的显式 retry，经真实 CLI 进程验证完整链路
// （SessionService 入队 retry 作业 → job 执行器改走 engine.retryRun →
// 状态机 failed→running → 只重跑失败节点）。门禁命令读取仓库外的标记
// 文件决定退出码，因此重试时无需改冻结计划，只需补放标记。
const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];
const markers: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
  for (const marker of markers.splice(0)) {
    rmSync(marker, { force: true });
  }
});

function run(repo: string, args: string[]) {
  const result = spawnSync(
    process.execPath,
    [cliPath, ...args, '--repo', repo],
    {
      cwd: repo,
      encoding: 'utf8',
      timeout: 60_000,
    },
  );
  expect(result.error).toBeUndefined();
  return result;
}

function fixture() {
  const repo = mkdtempSync(join(tmpdir(), 'tekon-cli-retry-'));
  roots.push(repo);
  const marker = join(tmpdir(), `tekon-retry-marker-${basename(repo)}`);
  markers.push(marker);
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@tekon.local'],
    ['config', 'user.name', 'Tekon Test'],
  ]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  // 标记文件不存在时门禁失败，补放标记后同一冻结命令即放行。
  writeFileSync(
    join(repo, 'gate-check.js'),
    `const fs = require('node:fs');\n` +
      `process.exit(fs.existsSync(${JSON.stringify(marker)}) ? 0 : 1);\n`,
  );
  execFileSync('git', ['add', 'gate-check.js'], {
    cwd: repo,
    stdio: 'pipe',
  });
  execFileSync('git', ['commit', '-m', 'fixture'], {
    cwd: repo,
    stdio: 'pipe',
  });
  expect(run(repo, ['init']).status).toBe(0);
  writeFileSync(
    join(repo, '.tekon', 'workflows', 'retry-fail.yaml'),
    JSON.stringify({
      id: 'retry-fail',
      governance: 'none',
      phases: [
        {
          id: 'dev',
          nodes: [
            {
              id: 'developer',
              role: 'rd',
              gates: [
                {
                  type: 'build',
                  commandRef: 'build',
                  autoFix: false,
                  maxRetries: 0,
                  onExhausted: 'fail',
                },
              ],
            },
          ],
        },
      ],
    }),
  );
  writeFileSync(
    join(repo, '.tekon', 'repo-profile.yaml'),
    'version: 1\ncommands:\n  build:\n    tool: node\n    args: [gate-check.js]\n',
  );
  return { repo, marker };
}

function runIdOf(output: string): string {
  const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(output)?.[1];
  expect(runId, output).toBeTruthy();
  return runId!;
}

function openDb(repo: string) {
  return openTekonDatabase({
    filename: join(repo, '.tekon', 'tekon.sqlite'),
  });
}

describe('PD-17 步 3 tekon retry 真实进程', () => {
  it('failed 运行被裸 resume 拒绝，retry 只重跑失败节点后 passed', () => {
    const { repo, marker } = fixture();
    expect(existsSync(marker)).toBe(false);

    // 1) 门禁耗尽（onExhausted=fail）→ run 与节点进入终态 failed。
    const first = run(repo, [
      'run',
      '失败重试真实进程',
      '--template',
      'retry-fail',
      '--agent',
      'mock',
      '--allow-dirty-base',
    ]);
    expect(first.status, first.stderr).toBe(1);
    expect(first.stdout).toContain('状态: failed');
    const runId = runIdOf(first.stdout);

    const db = openDb(repo);
    try {
      expect(
        db
          .prepare('select status from workflow_instances where id=?')
          .get(runId),
      ).toEqual({ status: 'failed' });
      expect(
        db
          .prepare('select status from nodes where run_id=?')
          .all(runId)
          .map((row) => (row as { status: string }).status),
      ).toContain('failed');
    } finally {
      db.close();
    }

    // 2) 裸 resume 仍按终态拒绝：retry 是独立显式入口，并给出 retry 提示。
    const resume = run(repo, ['resume', '--run-id', runId]);
    expect(resume.status, resume.stdout).toBe(1);
    expect(resume.stderr).toContain('终态 failed');
    expect(resume.stderr).toContain('tekon retry');

    // 3) 补放标记让同一冻结门禁放行，retry 后运行 passed。
    writeFileSync(marker, 'ok\n');
    const retry = run(repo, ['retry', '--run-id', runId]);
    expect(retry.status, retry.stderr).toBe(0);
    expect(retry.stderr).toContain('已入队失败重试');
    expect(retry.stdout).toContain('status=passed');

    const dbAfter = openDb(repo);
    try {
      expect(
        dbAfter
          .prepare('select status from workflow_instances where id=?')
          .get(runId),
      ).toEqual({ status: 'passed' });
      const nodeStatuses = dbAfter
        .prepare('select status from nodes where run_id=?')
        .all(runId)
        .map((row) => (row as { status: string }).status);
      expect(nodeStatuses).not.toContain('failed');
      expect(nodeStatuses).toContain('passed');
      const retryEvent = dbAfter
        .prepare('select payload from audit_events where run_id=? and type=?')
        .get(runId, 'run.retried') as { payload: string } | undefined;
      expect(retryEvent).toBeDefined();
      expect(JSON.parse(retryEvent!.payload)).toMatchObject({
        fromStatus: 'failed',
        toStatus: 'running',
      });
    } finally {
      dbAfter.close();
    }
  }, 120_000);

  it('retry 拒绝非 failed 运行：passed 运行按终态报错', () => {
    const { repo, marker } = fixture();
    // 首跑前门禁即可通过，运行直接 passed。
    writeFileSync(marker, 'ok\n');

    const first = run(repo, [
      'run',
      '非 failed 拒绝 retry',
      '--template',
      'retry-fail',
      '--agent',
      'mock',
      '--allow-dirty-base',
    ]);
    expect(first.status, first.stderr).toBe(0);
    const runId = runIdOf(first.stdout);

    const retry = run(repo, ['retry', '--run-id', runId]);
    expect(retry.status, retry.stdout).toBe(1);
    expect(retry.stderr).toContain('终态 passed');

    const db = openDb(repo);
    try {
      // 被拒绝的 retry 不得留下任何重试审计或新作业。
      expect(
        db
          .prepare(
            'select count(*) as count from audit_events where run_id=? and type=?',
          )
          .get(runId, 'run.retried'),
      ).toEqual({ count: 0 });
      expect(
        db
          .prepare('select status from workflow_instances where id=?')
          .get(runId),
      ).toEqual({ status: 'passed' });
    } finally {
      db.close();
    }
  }, 120_000);

  it('支持位置参数 runId，且重试后仍 failed 时退出码为 1', () => {
    const { repo, marker } = fixture();
    expect(existsSync(marker)).toBe(false);

    const first = run(repo, [
      'run',
      '重试后仍失败',
      '--template',
      'retry-fail',
      '--agent',
      'mock',
      '--allow-dirty-base',
    ]);
    expect(first.status, first.stderr).toBe(1);
    const runId = runIdOf(first.stdout);

    // 不补标记：同一冻结门禁必然再次失败。位置参数形式（无 --run-id）。
    const retry = run(repo, ['retry', runId]);
    expect(retry.status, retry.stderr).toBe(1);
    expect(retry.stderr).toContain('已入队失败重试');
    expect(retry.stdout).toContain('status=failed');

    const db = openDb(repo);
    try {
      expect(
        db
          .prepare('select status from workflow_instances where id=?')
          .get(runId),
      ).toEqual({ status: 'failed' });
      expect(
        db
          .prepare(
            'select count(*) as count from audit_events where run_id=? and type=?',
          )
          .get(runId, 'run.retried'),
      ).toEqual({ count: 1 });
      // 仍失败时可再次 retry：状态机开口不消耗次数。
      const secondRetry = run(repo, ['retry', runId]);
      expect(secondRetry.status, secondRetry.stderr).toBe(1);
      expect(
        db
          .prepare(
            'select count(*) as count from audit_events where run_id=? and type=?',
          )
          .get(runId, 'run.retried'),
      ).toEqual({ count: 2 });
    } finally {
      db.close();
    }
  }, 120_000);
});
