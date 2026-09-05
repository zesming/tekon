import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { approveDraftShape, openTekonDatabase, shapeDraft } from '@tekon/core';
import { afterEach, describe, expect, it } from 'vitest';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const temporaryRoots: string[] = [];
afterEach(() => {
  for (const dir of temporaryRoots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});
function temporaryRoot() {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-request-id-'));
  temporaryRoots.push(dir);
  return dir;
}
function run(
  repo: string,
  args: string[],
  cwd = repo,
  env?: NodeJS.ProcessEnv,
) {
  const result = spawnSync(
    process.execPath,
    [cliPath, ...args, '--repo', repo],
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 20_000,
    },
  );
  expect(result.error).toBeUndefined();
  return result;
}

function initializedRepo() {
  const repo = temporaryRoot();
  for (const args of [
    ['init', '-b', 'main'],
    ['config', 'user.email', 'test@tekon.local'],
    ['config', 'user.name', 'Tekon Test'],
  ]) {
    execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  }
  writeFileSync(join(repo, 'README.md'), '# CLI request identity\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'fixture'], {
    cwd: repo,
    stdio: 'pipe',
  });
  expect(run(repo, ['init']).status).toBe(0);
  return repo;
}

describe('CLI requestId 真进程合同', () => {
  it('绝对路径中的symlink/..保持实际读取引用，不与词法折叠路径共用身份', () => {
    const repo = initializedRepo();
    const lexicalRoot = temporaryRoot();
    const physicalRoot = temporaryRoot();
    mkdirSync(join(physicalRoot, 'sub'));
    symlinkSync(join(physicalRoot, 'sub'), join(lexicalRoot, 'link'), 'dir');
    for (const [root, text] of [[lexicalRoot, '词法文件需求'], [physicalRoot, '实际文件需求']]) {
      writeFileSync(join(root, 'request.json'), JSON.stringify(approveDraftShape(shapeDraft({ text }), { actor: 'test' })));
    }
    const prefix = ['run', '--goal', '--agent', 'mock', '--request-id', 'cli-absolute-link-01', '--draft-file'];
    const first = run(repo, [...prefix, `${lexicalRoot}/link/../request.json`]);
    expect(first.status, first.stderr).toBe(0);
    const db = openTekonDatabase({ filename: join(repo, '.tekon', 'tekon.sqlite') });
    try { expect((db.prepare('select body from demands').get() as { body: string }).body).toContain('实际文件需求'); }
    finally { db.close(); }
    const changed = run(repo, [...prefix, join(lexicalRoot, 'request.json')]);
    expect(changed.status, changed.stdout).toBe(1);
    expect(changed.stderr).toContain('REQUEST_ID_CONFLICT');
  });

  it('二次查询才发现已受理身份时，恢复错误仍保留赢家的全部ID', () => {
    const repo = initializedRepo();
    const scratch = temporaryRoot();
    const demandPath = join(scratch, 'demand.json');
    const preload = join(scratch, 'inject-read-failure.mjs');
    const requestId = 'cli-secondary-lookup-01';
    writeFileSync(
      demandPath,
      JSON.stringify(
        approveDraftShape(shapeDraft({ text: '二次查询恢复身份' }), {
          actor: 'test',
        }),
      ),
    );
    // This test-only preload lets another real CLI accept the request after
    // the first lookup. A DB trigger then makes directory-ready persistence
    // fail, so the second lookup has more identity evidence than the read error.
    writeFileSync(
      preload,
      `
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync } from 'node:child_process';
import { openTekonDatabase } from ${JSON.stringify(new URL('../../../core/dist/index.js', import.meta.url).href)};
const original = fs.readFileSync;
let injected = false;
fs.readFileSync = function (file, ...args) {
  if (!injected && String(file) === ${JSON.stringify(demandPath)}) {
    injected = true;
    execFileSync(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(), env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'pipe', timeout: 20000,
    });
    const db = openTekonDatabase({ filename: ${JSON.stringify(join(repo, '.tekon', 'tekon.sqlite'))} });
    try {
      db.prepare("update run_admissions set files_state='pending' where request_id=?").run(${JSON.stringify(requestId)});
      db.exec("create trigger fail_ready before update of files_state on run_admissions begin select raise(abort, 'RECOVERY_WRITE_FAILED'); end");
    } finally { db.close(); }
    throw new Error('DEMAND_READ_FAILED_WITHOUT_ID');
  }
  return original.call(this, file, ...args);
};
syncBuiltinESMExports();
`,
    );
    const result = run(
      repo,
      [
        'run',
        '--goal',
        '--agent',
        'mock',
        '--request-id',
        requestId,
        '--draft-file',
        demandPath,
      ],
      repo,
      { ...process.env, NODE_OPTIONS: `--import ${preload}` },
    );
    expect(result.status).toBe(1);
    const db = openTekonDatabase({
      filename: join(repo, '.tekon', 'tekon.sqlite'),
    });
    try {
      const admission = db
        .prepare(
          'select run_id, session_id, job_id from run_admissions where request_id=?',
        )
        .get(requestId) as {
        run_id: string;
        session_id: string;
        job_id: string;
      };
      expect(admission).toBeDefined();
      for (const id of [
        requestId,
        admission.run_id,
        admission.session_id,
        admission.job_id,
      ])
        expect(result.stderr).toContain(id);
      expect(result.stderr).toContain('admissionState=recovery-required');
    } finally {
      db.close();
    }
  }, 45_000);

  for (const fileFlag of ['--draft-file', '--demand-file']) {
    it(`${fileFlag} 绑定 cwd 优先候选，删除后可重放，不同 cwd 同名文件冲突`, () => {
      const repo = initializedRepo();
      const cwdA = temporaryRoot();
      const cwdB = temporaryRoot();
      const fileName = 'request.json';
      const writeDemand = (path: string, text: string) =>
        writeFileSync(
          path,
          JSON.stringify(
            approveDraftShape(shapeDraft({ text }), { actor: 'test' }),
          ),
        );
      writeDemand(join(repo, fileName), 'repo 候选的需求标记');
      writeDemand(join(cwdA, fileName), 'cwdA 首次读取的需求标记');
      writeDemand(join(cwdB, fileName), 'cwdB 另一份需求标记');
      const args = [
        'run',
        '--goal',
        '--agent',
        'mock',
        '--allow-dirty-base',
        '--request-id',
        'cli-cwd-reference-01',
        fileFlag,
        fileName,
      ];
      const first = run(repo, args, cwdA);
      expect(first.status, first.stderr).toBe(0);
      const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(first.stdout)?.[1];
      expect(runId).toBeTruthy();
      const db = openTekonDatabase({
        filename: join(repo, '.tekon', 'tekon.sqlite'),
      });
      try {
        const demand = db.prepare('select body from demands').get() as {
          body: string;
        };
        expect(demand.body).toContain('cwdA 首次读取的需求标记');
        expect(demand.body).not.toContain('repo 候选的需求标记');
      } finally {
        db.close();
      }
      unlinkSync(join(cwdA, fileName));
      const replay = run(repo, args, cwdA);
      expect(replay.status, replay.stderr).toBe(0);
      expect(replay.stdout).toContain(runId!);
      const conflict = run(repo, args, cwdB);
      expect(conflict.status, conflict.stdout).toBe(1);
      expect(conflict.stderr).toContain('REQUEST_ID_CONFLICT');
      const verified = openTekonDatabase({
        filename: join(repo, '.tekon', 'tekon.sqlite'),
      });
      try {
        for (const table of [
          'demands',
          'workflow_instances',
          'sessions',
          'jobs',
          'run_admissions',
        ]) {
          expect(
            verified.prepare(`select count(*) as count from ${table}`).get(),
          ).toEqual({ count: 1 });
        }
      } finally {
        verified.close();
      }
    }, 60_000);
  }

  it('repo 后备读取的引用不随 cwd 候选后来出现而改变', () => {
    const repo = initializedRepo();
    const cwd = temporaryRoot();
    const fileName = 'fallback.json';
    writeFileSync(
      join(repo, fileName),
      JSON.stringify(
        approveDraftShape(shapeDraft({ text: '首次 repo 后备需求' }), {
          actor: 'test',
        }),
      ),
    );
    const args = [
      'run',
      '--goal',
      '--agent',
      'mock',
      '--allow-dirty-base',
      '--request-id',
      'cli-fallback-reference-01',
      '--draft-file',
      fileName,
    ];
    const first = run(repo, args, cwd);
    expect(first.status, first.stderr).toBe(0);
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(first.stdout)?.[1];
    expect(runId).toBeTruthy();
    const db = openTekonDatabase({
      filename: join(repo, '.tekon', 'tekon.sqlite'),
    });
    try {
      expect(
        (db.prepare('select body from demands').get() as { body: string }).body,
      ).toContain('首次 repo 后备需求');
    } finally {
      db.close();
    }
    writeFileSync(
      join(cwd, fileName),
      JSON.stringify(
        approveDraftShape(shapeDraft({ text: '后出现的 cwd 候选' }), {
          actor: 'test',
        }),
      ),
    );
    unlinkSync(join(repo, fileName));
    const replay = run(repo, args, cwd);
    expect(replay.status, replay.stderr).toBe(0);
    expect(replay.stdout).toContain(runId!);
  }, 45_000);

  it('相同绝对文件引用不因发起 cwd 改变而冲突', () => {
    const repo = initializedRepo();
    const cwdA = temporaryRoot();
    const cwdB = temporaryRoot();
    const path = join(cwdA, 'absolute.json');
    writeFileSync(
      path,
      JSON.stringify(
        approveDraftShape(shapeDraft({ text: '绝对路径引用' }), {
          actor: 'test',
        }),
      ),
    );
    const args = [
      'run',
      '--goal',
      '--agent',
      'mock',
      '--request-id',
      'cli-absolute-reference-01',
      '--draft-file',
      path,
    ];
    const first = run(repo, args, cwdA);
    expect(first.status, first.stderr).toBe(0);
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(first.stdout)?.[1];
    expect(runId).toBeTruthy();
    unlinkSync(path);
    const replay = run(repo, args, cwdB);
    expect(replay.status, replay.stderr).toBe(0);
    expect(replay.stdout).toContain(runId!);
  }, 45_000);

  it('非法 requestId 在初始化前拒绝，不创建文件', () => {
    const repo = temporaryRoot();
    const result = run(repo, [
      'run',
      '不要创建',
      '--goal',
      '--agent',
      'mock',
      '--request-id',
      '../bad',
    ]);
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('REQUEST_ID_INVALID');
    expect(readdirSync(repo)).toEqual([]);
  });

  it('相同 requestId 重放同一 goal，仓库后来变脏也不创建新身份', () => {
    const repo = initializedRepo();
    const args = [
      'run',
      '执行一次 mock goal',
      '--goal',
      '--agent',
      'mock',
      '--request-id',
      'cli-replay-request-01',
    ];
    const first = run(repo, args);
    expect(first.status).toBe(0);
    expect(first.stderr).toContain('cli-replay-request-01');
    const firstId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(first.stdout)?.[1];
    expect(firstId).toBeTruthy();
    writeFileSync(
      join(repo, 'untracked-after-admission.txt'),
      '不能阻断原请求重放',
    );
    const replayed = run(repo, args);
    expect(replayed.status).toBe(0);
    expect(replayed.stdout).toContain(firstId!);
    const conflict = run(
      repo,
      args.map((arg) => (arg === '执行一次 mock goal' ? '不同需求' : arg)),
    );
    expect(conflict.status).toBe(1);
    expect(conflict.stderr).toContain('REQUEST_ID_CONFLICT');
    const db = openTekonDatabase({
      filename: join(repo, '.tekon', 'tekon.sqlite'),
    });
    try {
      expect(
        db.prepare('select count(*) as count from workflow_instances').get(),
      ).toEqual({ count: 1 });
      expect(
        db.prepare('select count(*) as count from sessions').get(),
      ).toEqual({ count: 1 });
      expect(db.prepare('select count(*) as count from jobs').get()).toEqual({
        count: 1,
      });
      expect(
        db
          .prepare(
            "select count(*) as count from audit_events where type='run.started'",
          )
          .get(),
      ).toEqual({ count: 1 });
      const row = db
        .prepare('select plan_snapshot, plan_digest from workflow_instances')
        .get() as { plan_snapshot: string; plan_digest: string };
      const snapshot = JSON.parse(row.plan_snapshot);
      expect(snapshot.digestVersion).toBe(2);
      expect(snapshot.mode).toBe('goal');
      expect(snapshot.template.id).toBe('goal');
      expect(row.plan_digest).toMatch(/^[a-f0-9]{64}$/);
    } finally {
      db.close();
    }
  }, 45_000);

  it('目录失败在run/status中可辨识，修复后复用原ID完成', () => {
    const repo = initializedRepo();
    const root = join(repo, '.tekon', 'runs');
    const backup = join(repo, '.tekon', 'runs-fixture-backup');
    if (existsSync(root)) renameSync(root, backup);
    writeFileSync(root, 'not a directory');
    const args = [
      'run',
      '可恢复目录失败',
      '--goal',
      '--agent',
      'mock',
      '--request-id',
      'cli-directory-01',
    ];
    const failed = run(repo, args);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('ADMISSION_RECOVERY_REQUIRED');
    expect(failed.stdout).toContain('尚未执行');
    const runId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(failed.stdout)?.[1];
    expect(runId).toBeTruthy();
    const status = run(repo, ['status', '--run-id', runId!]);
    expect(status.stdout).toContain('admission=recovery-required');
    expect(status.stdout).toContain('requestId=cli-directory-01');
    unlinkSync(root);
    if (existsSync(backup)) renameSync(backup, root);
    else mkdirSync(root);
    const recovered = run(repo, args);
    expect(recovered.status).toBe(0);
    expect(recovered.stdout).toContain(runId!);
  }, 45_000);

  it('动态预览不能携带看似会受理的requestId', () => {
    const repo = temporaryRoot();
    const result = run(repo, [
      'run',
      'preview',
      '--dynamic',
      '--dry-run',
      '--request-id',
      'cli-preview-01',
    ]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REQUEST_ID_UNSUPPORTED');
    expect(readdirSync(repo)).toEqual([]);
  });
});
