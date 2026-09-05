import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import type { CliIO } from '../lib/context.js';
import { withCommandCtx } from '../lib/context.js';
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
      const admission = await repositories.admissionStore.getAdmissionByRunId(runId);
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
          ...(admission ? [
            `admission=${admission.filesState === 'ready' ? 'accepted' : 'recovery-required'}`,
            `filesState=${admission.filesState}`,
            `requestId=${admission.requestId}`,
          ] : []),
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
  if (!existsSync(join(repoPath, '.tekon', 'config.yaml'))) {
    throw new Error(`项目未初始化: ${repoPath}。请运行 "tekon init" 初始化项目。`);
  }
  throw new Error(
    'CLEAN_SUSPENDED: tekon clean is suspended pending lifecycle-safe purge (see #33, #18)',
  );
}
