import { parseArgs } from 'node:util';

import {
  createAuditLogger,
  createHumanGate,
  createHumanApprovalSummary,
  createRepositories,
  evaluateHumanApprovalSummary,
  migrateDatabase,
  findLatestRunFailure,
  ProviderPreflightError,
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
import { providerRuntimeFromCliOptions } from '../lib/agent-factory.js';
import {
  formatBindingDiff,
  inspectRunBinding,
} from '../lib/binding-diff.js';
import { formatApprovalSummary } from './review.js';
import { formatPreflightNotice, runOutcomeDetails } from '../lib/run-outcome.js';

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
      // PD-31：显式只重跑门禁，不重跑 agent（节点须已有完成的 agent 执行）。
      'gates-only': { type: 'boolean', default: false },
      // PD-05：显式采用当前仓库配置（repo-profile 命令、可选 --agent），
      // 替换运行的冻结绑定后再恢复；缺省维持冻结。
      rebind: { type: 'boolean', default: false },
      agent: { type: 'string' },
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

    // PD-05：默认冻结。裸 resume 先做只读差异探测，当前仓库配置与冻结绑定
    // 不一致时给出提示但不阻断；--rebind 才显式采用新配置。
    if (!args.values.rebind) {
      const bindingDiff = inspectRunBinding({
        repoPath,
        workflow,
        frozenProvider: runProvider,
      });
      if (bindingDiff?.hasDifferences) {
        io.stderr.write(
          [
            '当前仓库配置与本运行的冻结绑定存在差异（默认仍按冻结绑定恢复）：',
            ...formatBindingDiff(bindingDiff),
            `要采用当前配置恢复，使用 tekon resume --run-id ${runId} --rebind。`,
          ].join('\n') + '\n',
        );
      }
    } else {
      // 缺省沿用冻结 provider（provider 名即受理时的 agent 名）；显式
      // --agent 才切换。引擎输入与 `tekon run` 同形，由组合根工厂构建快照。
      const rebindResult = await sessionService.rebindRun({
        runId,
        engine: {
          agent: args.values.agent ?? runProvider.provider,
          allowDirtyBase: workflow.allowDirtyBase ?? false,
          runtime: providerRuntimeFromCliOptions(args.values),
        },
        ...(args.values.agent !== undefined
          ? { agent: args.values.agent }
          : {}),
      });
      if (rebindResult.outcome === 'terminal') {
        throw new WorkflowTerminalError(runId, rebindResult.status);
      }
      if (rebindResult.outcome === 'active-job') {
        throw new Error(
          '运行已有活跃任务，请先使用 tekon cancel 取消或等待其完成。',
        );
      }
      if (rebindResult.diff.hasDifferences) {
        io.stderr.write(
          [
            '已按当前仓库配置重绑定（新冻结身份自洽，历史节点证据保留）：',
            ...formatBindingDiff(rebindResult.diff),
          ].join('\n') + '\n',
        );
      } else {
        io.stderr.write(
          '当前配置与冻结绑定无差异，绑定身份未改变，按原绑定恢复。\n',
        );
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
      // Check the provider before recording the approval, so a run that
      // cannot start does not leave a decision approved but not resumed. A
      // bare resume is checked inside resumeRun, after its state checks; a
      // finished run is reported as such by the approval below instead.
      if (!['passed', 'failed', 'cancelled'].includes(workflow.status)) {
        await sessionService.preflightResume(runId).catch(rethrowPreflight);
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
      ...(args.values['gates-only'] ? { gatesOnly: true } : {}),
      ...confirmation,
    }).catch((error: unknown) => {
      if (args.values['approve-human']) throw new Error(`审批已记录，运行尚未恢复：${error instanceof Error ? error.message : String(error)}`);
      return rethrowPreflight(error);
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

    io.stderr.write(formatPreflightNotice(result.preflight));
    jobRunner.start({ jobIds: [result.jobId] });
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
    const failure = findLatestRunFailure(await repositories.listAuditEvents(runId));
    const pendingHuman = (await repositories.listHumanDecisions(runId)).some(
      (decision) => decision.status === 'pending',
    );
    const details = runOutcomeDetails({ status, runId, failure, pendingHuman });
    if (details.length > 0) io.stdout.write(`${details.join('\n')}\n`);
    return exitCodeForJobOutcome({
      io,
      runId,
      jobId: result.jobId,
      jobStatus,
      workflowStatus: status,
      failure,
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

function rethrowPreflight(error: unknown): never {
  if (error instanceof ProviderPreflightError) {
    throw new Error(`${error.message}\n下一步: ${error.hint}`);
  }
  throw error;
}
