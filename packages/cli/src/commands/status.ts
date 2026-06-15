import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import type { CliIO } from '../lib/context.js';
import { ensureInitialized, withCommandCtx } from '../lib/context.js';
import { resolveProjectRepoPath } from '../lib/path-utils.js';

export async function commandStatus(
  argv: string[],
  io: CliIO,
) {
  await withCommandCtx(
    argv,
    io,
    async ({ repos: repositories, repoPath, runId }) => {
      const workflow = await repositories.getWorkflowInstance(runId);
      if (!workflow) {
        throw new Error(`未找到运行: ${runId}`);
      }
      const gates = await repositories.listGateResults(runId);
      const artifacts = await repositories.listArtifacts(runId);
      const pendingHuman = (
        await repositories.listHumanDecisions(runId)
      ).filter((decision) => decision.status === 'pending');
      io.stdout.write(
        [
          `runId=${runId}`,
          `repo=${repoPath}`,
          `status=${workflow.status}`,
          `currentNode=${workflow.currentNodeId ?? 'none'}`,
          `gates=${gates.length}`,
          `artifacts=${artifacts.length}`,
          `pendingHumanDecisions=${pendingHuman.length}`,
        ].join(' ') + '\n',
      );
    },
  );
}

export async function commandLog(
  argv: string[],
  io: CliIO,
) {
  await withCommandCtx(
    argv,
    io,
    async ({ repos: repositories, runId }) => {
      const events = await repositories.listAuditEvents(runId);
      for (const event of events) {
        io.stdout.write(
          `${event.createdAt} ${event.type} ${JSON.stringify(event.payload)}\n`,
        );
      }
    },
  );
}

export async function commandClean(
  argv: string[],
  io: CliIO,
) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  const worktreesDir = join(repoPath, '.tekon', 'worktrees');
  let cleaned = 0;
  if (existsSync(worktreesDir)) {
    cleaned = readdirSync(worktreesDir).length;
    rmSync(worktreesDir, { force: true, recursive: true });
  }
  mkdirSync(worktreesDir, { recursive: true });
  io.stdout.write(`清理工作树: ${cleaned} 个\n`);
}
