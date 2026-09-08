import { parseArgs } from 'node:util';

import {
  createAuditLogger,
  createHumanGate,
  createHumanApprovalSummary,
  createRepositories,
  evaluateHumanApprovalSummary,
  migrateDatabase,
  readRunRecovery,
  WorkflowTerminalError,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';
import {
  ensureInitialized,
  openProjectDb,
  withProjectContext,
} from '../lib/context.js';
import {
  resolveHumanDecisionContext,
  selectLatestRunId,
} from '../lib/db-helpers.js';
import { resolveProjectRepoPath } from '../lib/path-utils.js';
import {
  awaitJobTerminal,
  exitCodeForJobOutcome,
  withCliSessionContext,
  withSessionCommandCtx,
} from '../lib/session-context.js';
import { formatApprovalSummary } from './review.js';

export async function commandApproval(argv: string[], io: CliIO) {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'summary') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        'decision-id': { type: 'string' },
        json: { type: 'boolean', default: false },
        'max-chars': { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(args.values.repo);
    await ensureInitialized(repoPath, io);
    const maxContentChars = args.values['max-chars']
      ? Number(args.values['max-chars'])
      : 1_200;
    if (!Number.isFinite(maxContentChars) || maxContentChars <= 0) {
      throw new Error('--max-chars 必须是正数');
    }
    const db = openProjectDb(repoPath);
    migrateDatabase(db);
    try {
      const repositories = createRepositories(db);
      const { runId, decisionId } = await resolveHumanDecisionContext({
        db,
        repositories,
        explicitRunId: args.values['run-id'] ?? args.positionals[0],
        explicitDecisionId: args.values['decision-id'],
      });
      const explicitCommandDisplay = Boolean(
        args.values.repo ??
        args.values['run-id'] ??
        args.positionals[0] ??
        args.values['decision-id'],
      );
      const audit = createAuditLogger({ repositories });
      const summary = await createHumanApprovalSummary({
        repoPath,
        repositories,
        audit,
        runId,
        decisionId,
        maxContentChars,
        commandDisplay: explicitCommandDisplay ? 'explicit' : 'default',
      });
      const evaluation = evaluateHumanApprovalSummary(summary);
      io.stdout.write(
        args.values.json
          ? `${JSON.stringify({ summary, evaluation }, null, 2)}\n`
          : formatApprovalSummary(summary, evaluation),
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand === 'reject') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        'decision-id': { type: 'string' },
        actor: { type: 'string' },
        note: { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(args.values.repo);
    await ensureInitialized(repoPath, io);
    const db = openProjectDb(repoPath);
    migrateDatabase(db);
    try {
      const repositories = createRepositories(db);
      const { runId, decisionId } = await resolveHumanDecisionContext({
        db,
        repositories,
        explicitRunId: args.values['run-id'] ?? args.positionals[0],
        explicitDecisionId: args.values['decision-id'] ?? args.positionals[1],
        requireDecision: true,
      });
      if (!decisionId) {
        throw new Error(
          '无法推断待审批的人工决策，请使用 --run-id 和 --decision-id 参数指定',
        );
      }
      const audit = createAuditLogger({ repositories });
      const decision = await repositories.getHumanDecision(decisionId);
      if (!decision || decision.runId !== runId) {
        throw new Error(`未找到人工决策: ${decisionId}`);
      }
      if (decision.status !== 'pending') {
        throw new Error(
          `决策 ${decisionId} 已经是 ${decision.status} 状态，无法再次操作`,
        );
      }
      const rejected = await createHumanGate({
        repositories,
      }).rejectHumanGate(
        decisionId,
        args.values.actor ?? 'cli',
        args.values.note ?? 'rejected by CLI',
      );
      await audit.append({
        runId,
        type: 'human.gate.rejected',
        payload: {
          decisionId,
          nodeId: rejected.nodeId,
          actor: args.values.actor ?? 'cli',
        },
      });
      const workflow = await repositories.getWorkflowInstance(runId);
      io.stdout.write(
        [
          `runId=${runId}`,
          `decisionId=${decisionId}`,
          `decisionStatus=${rejected.status}`,
          `status=${workflow?.status ?? 'blocked'}`,
        ].join(' ') + '\n',
      );
    } finally {
      db.close();
    }
    return;
  }

  throw new Error(
    `未知的 approval 子命令: ${subcommand ?? ''}。请使用 tekon help approval 查看可用子命令。`,
  );
}

export async function commandPause(argv: string[], io: CliIO): Promise<number> {
  await withSessionCommandCtx(
    argv,
    io,
    async ({ repositories, runId, sessionService }) => {
      const workflow = await repositories.getWorkflowInstance(runId);
      if (!workflow) {
        throw new Error(`未找到运行: ${runId}`);
      }
      const result = await sessionService.requestPause({ runId });
      if (result.outcome === 'paused') {
        io.stdout.write(`runId=${runId} status=paused
`);
        return;
      }

      const status = result.workflowStatus ?? workflow.status;
      if (
        status === 'passed' ||
        status === 'failed' ||
        status === 'cancelled'
      ) {
        throw new WorkflowTerminalError(runId, status);
      }
      throw new Error(`运行 ${runId} 当前状态为 ${status}，无法暂停。`);
    },
  );
  return 0;
}

export async function commandResume(
  argv: string[],
  io: CliIO,
): Promise<number> {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
      'decision-id': { type: 'string' },
      'approve-human': { type: 'boolean', default: false },
      'confirm-stopped': { type: 'boolean', default: false },
      'previous-job-id': { type: 'string' },
    },
    allowPositionals: true,
  });
  const rawPreviousJobId = args.values['previous-job-id'];
  const confirmation = {
    confirmStopped: args.values['confirm-stopped'],
    ...(rawPreviousJobId !== undefined ? { previousJobId: rawPreviousJobId === 'none' ? null : rawPreviousJobId } : {}),
  };
  if (rawPreviousJobId !== undefined && !confirmation.confirmStopped) {
    throw new Error('--previous-job-id 必须与 --confirm-stopped 配合；请先检查旧进程是否退出。');
  }
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  // 4c §4.2.1 (S5): resume goes through SessionService + an embedded job
  // runner, same shape as `run` — the resumed job is awaited to a terminal
  // state before the process exits.
  return withCliSessionContext(repoPath, io, async (ctx) => {
    const { db, repositories, audit, sessionService, jobs, jobRunner } = ctx;
    let decisionContext: {
      runId: string;
      decisionId?: string;
    } | null = null;
    if (args.values['approve-human']) {
      decisionContext = await resolveHumanDecisionContext({
        db,
        repositories,
        explicitRunId: args.values['run-id'] ?? args.positionals[0],
        explicitDecisionId: args.values['decision-id'] ?? args.positionals[1],
        requireDecision: true,
      });
    }
    const runId =
      decisionContext?.runId ??
      args.values['run-id'] ??
      args.positionals[0] ??
      selectLatestRunId(db);
    if (!runId) {
      throw new Error('无法推断运行 ID，请使用 --run-id <runId> 指定');
    }
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`未找到运行: ${runId}`);
    }

    // Provider snapshot pre-check: without it the executor would fail the
    // resumed job asynchronously. Keep the synchronous, specific error
    // (asserted by run-cli.test.ts).
    const runProvider = await repositories.getRunProviderConfig(runId);
    if (!runProvider) {
      throw new Error(
        `运行 ${runId} 没有 provider 快照，无法安全恢复。请确认该运行是否正常启动过。`,
      );
    }

    const recovery = readRunRecovery(db, runId).resumeRecovery;
    if (recovery && (recovery.requiresConfirmation || confirmation.confirmStopped)) {
      if (!confirmation.confirmStopped || confirmation.previousJobId !== recovery.previousJobId) {
        throw new Error(`旧进程退出未确认或确认已过期。检查并停止旧执行后，使用 --confirm-stopped --previous-job-id ${recovery.previousJobId ?? 'none'} 重试同一运行。`);
      }
    }

    if (args.values['approve-human']) {
      if (!decisionContext?.decisionId) {
        throw new Error(
          '无法推断待审批的人工决策，请使用 --run-id 和 --decision-id 参数指定',
        );
      }
      const decision = await repositories.getHumanDecision(
        decisionContext.decisionId,
      );
      if (!decision || decision.runId !== runId) {
        throw new Error(`未找到人工决策: ${decisionContext.decisionId}`);
      }
      if (decision.status !== 'pending') {
        throw new Error(
          `决策 ${decisionContext.decisionId} 已经是 ${decision.status} 状态，无法再次操作`,
        );
      }
      const humanGate = createHumanGate({
        repositories,
      });
      try {
        await humanGate.approveHumanGate(decision.id, 'cli', 'approved by CLI');
        await repositories.transitionNode(decision.nodeId, 'awaiting-gate');
        await audit.append({
          runId,
          type: 'human.gate.approved',
          payload: {
            decisionId: decision.id,
            nodeId: decision.nodeId,
          },
        });
      } catch (error) {
        const recorded = await repositories.getHumanDecision(decision.id);
        if (recorded?.status === 'approved') {
          throw new Error(`审批已记录，运行尚未恢复：${error instanceof Error ? error.message : String(error)}`);
        }
        throw error;
      }
    }

    // When --approve-human just approved a decision, mirror web's gate.approve:
    // drive the run forward without re-blocking on other pending decisions (the
    // engine re-pauses at the next human gate). A bare resume keeps the guard.
    const result = await sessionService.resumeRun({
      runId,
      afterApproval: args.values['approve-human'],
      ...confirmation,
    }).catch((error: unknown) => {
      if (args.values['approve-human']) throw new Error(`审批已记录，运行尚未恢复：${error instanceof Error ? error.message : String(error)}`);
      throw error;
    });
    if (result.outcome !== 'enqueued' && args.values['approve-human']) {
      io.stderr.write(`审批已记录，运行尚未恢复（${result.outcome}）。请检查状态后重试。\n`);
    }
    if (result.outcome === 'exit-unconfirmed' || result.outcome === 'stale-confirmation') {
      throw new Error(`旧进程退出未确认或确认已过期。检查并停止旧执行后，使用 --confirm-stopped --previous-job-id ${result.previousJobId ?? 'none'} 重试。`);
    }
    if (result.outcome === 'pending-decisions') {
      throw new Error(
        '运行存在待审批的人工决策，请先使用 tekon resume --approve-human 批准或 tekon approval reject 拒绝。',
      );
    }
    if (result.outcome === 'terminal') {
      throw new WorkflowTerminalError(runId, result.status);
    }
    if (result.outcome === 'active-job') {
      throw new Error(
        '运行已有活跃任务，请先使用 tekon cancel 取消或等待其完成。',
      );
    }
    if (result.outcome === 'recovery-required') {
      throw new Error(`ADMISSION_RECOVERY_REQUIRED: runId=${runId}，修复目录准备问题后重试原请求。`);
    }

    jobRunner.start();
    const onSigint = () => {
      void jobRunner.requestCancel(result.jobId, 'cli SIGINT').catch(() => {});
    };
    process.on('SIGINT', onSigint);
    let jobStatus: Awaited<ReturnType<typeof awaitJobTerminal>>;
    try {
      jobStatus = await awaitJobTerminal({
        jobs,
        jobRunner,
        jobId: result.jobId,
      });
    } finally {
      process.removeListener('SIGINT', onSigint);
    }

    const latest = await repositories.getWorkflowInstance(runId);
    const status = latest?.status ?? 'unknown';
    io.stdout.write(`runId=${runId} status=${status}\n`);
    return exitCodeForJobOutcome({
      io,
      runId,
      jobId: result.jobId,
      jobStatus,
      workflowStatus: status,
    });
  });
}

export async function commandCancel(
  argv: string[],
  io: CliIO,
): Promise<number> {
  // 4c (design §4.3): cancel goes through SessionService. Its first step is
  // writeWorkflowTerminal(runId, 'cancelled') — the CAS guard that makes a
  // racing engine completion throw instead of writing a false `passed`,
  // regardless of which process holds the run. When another process holds
  // the run, jobRunner.requestCancel persists `cancelling` on the job row;
  // the holder's observation loop relays it to its in-process abort+killAll.
  await withSessionCommandCtx(
    argv,
    io,
    async ({ repositories, runId, sessionService }) => {
      const workflow = await repositories.getWorkflowInstance(runId);
      if (!workflow) {
        throw new Error(`未找到运行: ${runId}`);
      }
      await sessionService.requestCancel({ runId });
      const latest = await repositories.getWorkflowInstance(runId);
      io.stdout.write(
        `runId=${runId} status=${latest?.status ?? 'cancelled'}\n`,
      );
    },
  );
  return 0;
}
