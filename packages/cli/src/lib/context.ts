import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
  writeDefaultRepoProfile,
  type TekonDatabase,
  type TekonRepositories,
} from '@tekon/core';

import { selectLatestRunId } from './db-helpers.js';
import { resolveProjectRepoPath } from './path-utils.js';
import { basenameForProject, readStdinLine } from './utils.js';

export interface CliIO {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export function openProjectDb(repoPath: string): TekonDatabase {
  mkdirSync(join(repoPath, '.tekon'), { recursive: true });
  return openTekonDatabase({
    filename: join(repoPath, '.tekon', 'tekon.sqlite'),
  });
}

export async function withProjectContext<T>(
  repoPath: string,
  fn: (ctx: {
    db: TekonDatabase;
    repos: TekonRepositories;
  }) => T | Promise<T>,
): Promise<T> {
  const db = openProjectDb(repoPath);
  try {
    migrateDatabase(db);
    return await fn({ db, repos: createRepositories(db) });
  } finally {
    db.close();
  }
}

export async function withCommandCtx<T>(
  argv: string[],
  io: CliIO,
  fn: (ctx: {
    db: TekonDatabase;
    repos: TekonRepositories;
    repoPath: string;
    runId: string;
  }) => T | Promise<T>,
): Promise<T> {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  return withProjectContext(repoPath, ({ db, repos }) => {
    const runId =
      args.values['run-id'] ??
      args.positionals[0] ??
      selectLatestRunId(db);
    if (!runId) {
      throw new Error(
        '无法推断运行 ID，请使用 --run-id <runId> 指定',
      );
    }
    return fn({ db, repos, repoPath, runId });
  });
}

export async function ensureInitialized(
  repoPath: string,
  io: CliIO,
): Promise<void> {
  if (existsSync(join(repoPath, '.tekon', 'config.yaml'))) {
    return;
  }

  io.stdout.write(`项目尚未初始化: ${repoPath}\n`);
  io.stdout.write('是否立即初始化？[Y/n] ');

  const answer = await readStdinLine();
  if (!answer || answer.toLowerCase().startsWith('y')) {
    io.stdout.write('\n');
    initializeProject(repoPath, io);
    return;
  }

  io.stdout.write('\n');
  throw new Error(
    `项目未初始化: ${repoPath}。请运行 "tekon init" 初始化项目。`,
  );
}

export function initializeProject(
  repoPath: string,
  io: CliIO,
): void {
  const tekonDir = join(repoPath, '.tekon');
  mkdirSync(join(tekonDir, 'runs'), { recursive: true });
  mkdirSync(join(tekonDir, 'roles'), { recursive: true });
  mkdirSync(join(tekonDir, 'workflows'), { recursive: true });
  mkdirSync(join(tekonDir, 'worktrees'), { recursive: true });
  mkdirSync(join(tekonDir, 'eval'), { recursive: true });
  const webSessionPath = join(tekonDir, 'web-session.json');
  if (!existsSync(webSessionPath)) {
    writeFileSync(
      webSessionPath,
      JSON.stringify(
        { token: randomBytes(32).toString('hex') },
        null,
        2,
      ),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  writeFileSync(
    join(tekonDir, 'config.yaml'),
    stringifyYaml({
      project: { name: basenameForProject(repoPath), repoPath },
      storage: { dataDir: '.tekon' },
      defaultAgent: 'codex',
    }),
    'utf8',
  );
  const db = openProjectDb(repoPath);
  try {
    migrateDatabase(db);
  } finally {
    db.close();
  }
  const profilePath = join(tekonDir, 'repo-profile.yaml');
  if (!existsSync(profilePath)) {
    writeDefaultRepoProfile(repoPath);
  }
  io.stdout.write(
    [
      '项目初始化完成',
      `仓库路径: ${repoPath}`,
      '',
      '后续操作:',
      '  tekon draft new <需求描述>  创建需求草稿',
      '  tekon role list               查看可用角色',
      '  tekon workflow list           查看可用工作流',
      '',
    ].join('\n'),
  );
}
