import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { approveDraftShape, openTekonDatabase, shapeDraft } from '@tekon/core';
import { afterEach, describe, expect, it } from 'vitest';

import { writePermissiveRepoProfile } from '../helpers/repo-profile.js';

// PD-08：默认模板切到 lightweight-delivery，CLI 统一采纳 Draft 推荐，
// 以及受理重放合同（身份 envelope 与执行模板分层）。
const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const dir of temporaryRoots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-pd08-'));
  temporaryRoots.push(dir);
  return dir;
}

function run(repo: string, args: string[]) {
  return spawnSync(process.execPath, [cliPath, ...args, '--repo', repo], {
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function initializedRepo(): string {
  const repo = temporaryRoot();
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@tekon.local'],
    ['config', 'user.name', 'Tekon Test'],
  ]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  writeFileSync(join(repo, 'README.md'), '# PD-08 fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], {
    cwd: repo,
    stdio: 'pipe',
  });
  expect(run(repo, ['init']).status).toBe(0);
  // 惰性命令配置，让带 build/lint/test 门禁的重模板在 mock 下也能受理执行，
  // 不干扰本文件只验证「模板如何被选择/持久化」的关注点。
  writePermissiveRepoProfile(repo);
  return repo;
}

function runIdFrom(output: string): string {
  const id = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(output)?.[1];
  expect(id).toBeTruthy();
  return id!;
}

// 受理成功的退出码取决于模板门禁：passed=0、在人工 gate 暂停=3；
// 本文件只验证模板选择，故接受 0/3，仅把 1（受理/执行错误）视为失败。
function expectAccepted(result: ReturnType<typeof run>): void {
  expect(
    [0, 3].includes(result.status ?? -1),
    `expected accepted (0/3), got ${result.status}: ${result.stderr}`,
  ).toBe(true);
}

// 读取该 repo 唯一一次 run 落库的执行模板 id（独立 repo 保证只有一行）。
function persistedTemplateId(repo: string): string {
  const db = openTekonDatabase({
    filename: join(repo, '.tekon', 'tekon.sqlite'),
  });
  try {
    const row = db
      .prepare('select plan_snapshot from workflow_instances')
      .get() as { plan_snapshot: string };
    return JSON.parse(row.plan_snapshot).template.id as string;
  } finally {
    db.close();
  }
}

function approvedDraft(repo: string, text: string): string {
  const path = join(repo, 'pd08-draft.json');
  writeFileSync(
    path,
    JSON.stringify(
      approveDraftShape(shapeDraft({ text }), { actor: 'pd08-test' }),
    ),
  );
  return path;
}

describe('PD-08 CLI 默认模板与 Draft 推荐（真实进程）', () => {
  it('无 Draft 且未显式指定时，workflow run 默认落 lightweight-delivery', () => {
    const repo = initializedRepo();
    // workflow 模板含人工 gate，受理后暂停（退出码 3 是 paused 标准合同）。
    const result = run(repo, [
      'run',
      '给小工具加个减法函数',
      '--agent',
      'mock',
    ]);
    expect(result.status, result.stderr).toBe(3);
    expect(runIdFrom(result.stdout)).toBeTruthy();
    expect(persistedTemplateId(repo)).toBe('lightweight-delivery');
  });

  it('显式 --template 优先于一切，落指定模板', () => {
    const repo = initializedRepo();
    const result = run(repo, [
      'run',
      '修复一个明确的缺陷',
      '--template',
      'bugfix',
      '--agent',
      'mock',
    ]);
    expectAccepted(result);
    expect(persistedTemplateId(repo)).toBe('bugfix');
  });

  it('采纳已批准 Draft 的 recommendedTemplate（无显式 --template）', () => {
    const repo = initializedRepo();
    // 普通功能需求经 classifyDraft 推荐 standard-feature（受控枚举之一）。
    const draftPath = approvedDraft(
      repo,
      '给 Web dashboard 增加一个全新的需求塑形入口',
    );
    const shaped = shapeDraft({
      text: '给 Web dashboard 增加一个全新的需求塑形入口',
    });
    expect(shaped.recommendedTemplate).toBe('standard-feature');

    const result = run(repo, [
      'run',
      '--draft-file',
      draftPath,
      '--agent',
      'mock',
      // Draft 文件位于 repo 内使工作树变脏，与命令/模板选择无关。
      '--allow-dirty-base',
    ]);
    expectAccepted(result);
    expect(persistedTemplateId(repo)).toBe('standard-feature');
    // 展示行必须与实际生效模板一致：修复前这里误报静态缺省
    // lightweight-delivery，现从持久化计划快照回读生效模板。
    expect(result.stdout).toMatch(/模板:\s*standard-feature/u);
    expect(result.stdout).not.toMatch(/模板:\s*lightweight-delivery/u);
  });

  it('显式 --template 覆盖 Draft 的 recommendedTemplate', () => {
    const repo = initializedRepo();
    const draftPath = approvedDraft(
      repo,
      '给 Web dashboard 增加一个全新的需求塑形入口',
    );
    const result = run(repo, [
      'run',
      '--draft-file',
      draftPath,
      '--template',
      'bugfix',
      '--agent',
      'mock',
      '--allow-dirty-base',
    ]);
    expectAccepted(result);
    expect(persistedTemplateId(repo)).toBe('bugfix');
  });

  it('--goal 优先级最高，落 goal 模板并自动跑到 passed', () => {
    const repo = initializedRepo();
    const result = run(repo, [
      'run',
      '一次只读的目标任务',
      '--goal',
      '--agent',
      'mock',
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(persistedTemplateId(repo)).toBe('goal');
  });

  it('Draft 推荐受理后删除 Draft，同 requestId 重放返回同一 run 且执行模板不变', () => {
    const repo = initializedRepo();
    const draftPath = approvedDraft(
      repo,
      '给 Web dashboard 增加一个全新的需求塑形入口',
    );
    const requestId = 'pd08-replay-01';
    const args = [
      'run',
      '--draft-file',
      draftPath,
      '--agent',
      'mock',
      '--allow-dirty-base',
      '--request-id',
      requestId,
    ];
    const first = run(repo, args);
    expectAccepted(first);
    const firstRunId = runIdFrom(first.stdout);
    // 首次受理执行的是 Draft 推荐模板。
    expect(persistedTemplateId(repo)).toBe('standard-feature');

    // 删除 Draft 文件后用完全相同的参数重放：身份 envelope 不读 Draft，
    // 必须命中既有受理记录返回同一 run，而不是 ENOENT / REQUEST_ID_CONFLICT。
    unlinkSync(draftPath);
    const replay = run(repo, args);
    expectAccepted(replay);
    expect(runIdFrom(replay.stdout)).toBe(firstRunId);
    expect(persistedTemplateId(repo)).toBe('standard-feature');
  });
});
