import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  createAuditLogger,
  createCommandGateway,
  createRepositories,
  createRunCleanup,
  createWorktreeManager,
  createWriteQueue,
  migrateDatabase,
  type RunCleanupCandidate,
  type RunCleanupReport,
} from '@tekon/core';

import { openProjectDb, type CliIO } from '../lib/context.js';
import { resolveProjectRepoPath } from '../lib/path-utils.js';

const KEPT = '保留: tekon-delivery 交付分支、.tekon/runs 下的运行证据和审计记录';

/**
 * Removes worktrees and node branches left by finished runs. Without
 * --run-id it lists the runs first and acts only with --yes.
 */
export async function commandClean(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
    allowPositionals: false,
  });
  const runId = args.values['run-id'];
  if (runId !== undefined && runId.trim() === '') {
    throw new Error('--run-id 不能为空。要清理所有已结束的运行，请去掉 --run-id。');
  }
  const repoPath = resolveProjectRepoPath(args.values.repo);
  if (!existsSync(join(repoPath, '.tekon', 'config.yaml'))) {
    throw new Error(`项目未初始化: ${repoPath}。请运行 "tekon init" 初始化项目。`);
  }
  const dryRun = args.values['dry-run'] ?? false;

  const db = openProjectDb(repoPath);
  try {
    migrateDatabase(db);
    const writeQueue = createWriteQueue({ isClosed: () => db.isClosed() });
    const repositories = createRepositories(db, writeQueue);
    const cleanup = createRunCleanup({
      db,
      repositories,
      audit: createAuditLogger({ repositories, db, writeQueue }),
      worktreeManager: createWorktreeManager({
        repositories,
        gateway: createCommandGateway({ repositories }),
      }),
      repoPath,
    });

    const planned = await cleanup.plan(runId);
    const work = planned.filter((item) => item.worktrees.length + item.branches.length > 0);
    if (work.length === 0) {
      io.stdout.write(
        runId
          ? `运行 ${runId} 没有需要清理的 worktree 或节点分支。\n`
          : '没有需要清理的运行。\n',
      );
      return 0;
    }
    if (dryRun || (!runId && !args.values.yes)) {
      io.stdout.write(
        [
          `将清理 ${work.length} 个已结束的运行:`,
          ...work.map(describeCandidate),
          KEPT,
          dryRun ? '预览，没有做任何改动。' : '确认后执行: tekon clean --yes',
          '',
        ].join('\n'),
      );
      return 0;
    }

    let failed = false;
    const lines: string[] = [];
    // One run failing does not stop the others; each gets its own line.
    for (const item of work) {
      try {
        const report = await cleanup.clean(item.runId);
        if (report.failures.length > 0) failed = true;
        lines.push(describeReport(report));
      } catch (error) {
        failed = true;
        lines.push(`未能清理 ${item.runId}：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    lines.push(KEPT, '');
    io.stdout.write(lines.join('\n'));
    return failed ? 1 : 0;
  } finally {
    db.close();
  }
}

function describeCandidate(item: RunCleanupCandidate): string {
  return `  ${item.runId}（${item.status}）：worktree ${item.worktrees.length} 个，节点分支 ${item.branches.length} 个`;
}

function describeReport(report: RunCleanupReport): string {
  const missing = report.worktreesMissing + report.branchesMissing;
  return [
    `已清理 ${report.runId}：移除 worktree ${report.worktreesRemoved} 个，删除节点分支 ${report.branchesDeleted} 个`,
    missing > 0 ? `（${missing} 项已不存在）` : '',
    report.failures.length > 0
      ? `；${report.failures.length} 项未能清理，详情见 tekon log --run-id ${report.runId}`
      : '',
  ].join('');
}
