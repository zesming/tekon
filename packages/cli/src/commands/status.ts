import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { classifyExecutionBinding } from '@tekon/core';

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
    async ({ db, repos: repositories, repoPath, runId }) => {
      const workflow = await repositories.getWorkflowInstance(runId);
      if (!workflow) {
        throw new Error(`未找到运行: ${runId}`);
      }
      const gates = await repositories.listGateResults(runId);
      const artifacts = await repositories.listArtifacts(runId);
      const admission = await repositories.admissionStore.getAdmissionByRunId(runId);
      const persisted = db.prepare('select plan_snapshot, plan_digest, kind from workflow_instances where id=?').get(runId) as
        { plan_snapshot: string | null; plan_digest: string | null; kind: 'workflow' | 'goal' };
      const executionBinding = classifyExecutionBinding({
        planSnapshot: persisted.plan_snapshot, planDigest: persisted.plan_digest,
        kind: persisted.kind, hasAdmission: Boolean(admission),
      });
      if (executionBinding === 'legacy-unbound') {
        io.stderr.write('历史计划未记录仓库命令绑定；使用 commandRef 时按当前配置解析。\n');
      } else if (executionBinding === 'invalid') {
        io.stderr.write('执行计划校验失败；请检查持久记录，不能视为已冻结计划。\n');
      } else if (executionBinding === 'unknown') {
        io.stderr.write('执行绑定状态待确认；当前版本不能识别该计划。\n');
      }
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
          `executionBinding=${executionBinding}`,
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
