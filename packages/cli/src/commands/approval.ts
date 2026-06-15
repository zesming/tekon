import { parseArgs } from 'node:util';

import {
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createHumanGate,
  createHumanApprovalSummary,
  createRepositories,
  createWorktreeManager,
  createWorkflowEngine,
  evaluateHumanApprovalSummary,
  migrateDatabase,
} from '@tekon/core';

import {
  createAgentAdapterFromSnapshot,
} from '../lib/agent-factory.js';
import type { CliIO } from '../lib/context.js';
import {
  ensureInitialized,
  openProjectDb,
  withCommandCtx,
  withProjectContext,
} from '../lib/context.js';
import {
  resolveHumanDecisionContext,
  selectLatestRunId,
} from '../lib/db-helpers.js';
import { resolveProjectRepoPath } from '../lib/path-utils.js';
import {
  getBuiltInRolesDir,
} from '../lib/utils.js';
import {
  formatApprovalSummary,
} from './review.js';

export async function commandApproval(
  argv: string[],
  io: CliIO,
) {
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
    const repoPath = resolveProjectRepoPath(
      args.values.repo,
    );
    await ensureInitialized(repoPath, io);
    const maxContentChars = args.values['max-chars']
      ? Number(args.values['max-chars'])
      : 1_200;
    if (
      !Number.isFinite(maxContentChars) ||
      maxContentChars <= 0
    ) {
      throw new Error('--max-chars 必须是正数');
    }
    const db = openProjectDb(repoPath);
    migrateDatabase(db);
    try {
      const repositories = createRepositories(db);
      const { runId, decisionId } =
        await resolveHumanDecisionContext({
          db,
          repositories,
          explicitRunId:
            args.values['run-id'] ?? args.positionals[0],
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
        commandDisplay: explicitCommandDisplay
          ? 'explicit'
          : 'default',
      });
      const evaluation =
        evaluateHumanApprovalSummary(summary);
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
    const repoPath = resolveProjectRepoPath(
      args.values.repo,
    );
    await ensureInitialized(repoPath, io);
    const db = openProjectDb(repoPath);
    migrateDatabase(db);
    try {
      const repositories = createRepositories(db);
      const { runId, decisionId } =
        await resolveHumanDecisionContext({
          db,
          repositories,
          explicitRunId:
            args.values['run-id'] ?? args.positionals[0],
          explicitDecisionId:
            args.values['decision-id'] ??
            args.positionals[1],
          requireDecision: true,
        });
      if (!decisionId) {
        throw new Error(
          '无法推断待审批的人工决策，请使用 --run-id 和 --decision-id 参数指定',
        );
      }
      const audit = createAuditLogger({ repositories });
      const decision =
        await repositories.getHumanDecision(decisionId);
      if (!decision || decision.runId !== runId) {
        throw new Error(
          `未找到人工决策: ${decisionId}`,
        );
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
      const workflow =
        await repositories.getWorkflowInstance(runId);
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

export async function commandPause(
  argv: string[],
  io: CliIO,
) {
  await withCommandCtx(
    argv,
    io,
    async ({ repos: repositories, runId }) => {
      const workflow =
        await repositories.getWorkflowInstance(runId);
      if (!workflow) {
        throw new Error(`未找到运行: ${runId}`);
      }
      if (workflow.currentNodeId) {
        await repositories.transitionNode(
          workflow.currentNodeId,
          'paused',
        );
      }
      const paused =
        await repositories.updateWorkflowInstanceStatus(
          runId,
          'paused',
          workflow.currentNodeId,
        );
      io.stdout.write(
        `runId=${runId} status=${paused?.status ?? 'paused'}\n`,
      );
    },
  );
}

export async function commandResume(
  argv: string[],
  io: CliIO,
) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
      'decision-id': { type: 'string' },
      'approve-human': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  await withProjectContext(
    repoPath,
    async ({ db, repos: repositories }) => {
      let decisionContext: {
        runId: string;
        decisionId?: string;
      } | null = null;
      if (args.values['approve-human']) {
        decisionContext = await resolveHumanDecisionContext(
          {
            db,
            repositories,
            explicitRunId:
              args.values['run-id'] ??
              args.positionals[0],
            explicitDecisionId:
              args.values['decision-id'] ??
              args.positionals[1],
            requireDecision: true,
          },
        );
      }
      const runId =
        decisionContext?.runId ??
        args.values['run-id'] ??
        args.positionals[0] ??
        selectLatestRunId(db);
      if (!runId) {
        throw new Error(
          '无法推断运行 ID，请使用 --run-id <runId> 指定',
        );
      }
      const audit = createAuditLogger({ repositories });
      const workflow =
        await repositories.getWorkflowInstance(runId);
      if (!workflow) {
        throw new Error(`未找到运行: ${runId}`);
      }

      const gateway = createCommandGateway({
        repositories,
      });
      const runProvider =
        await repositories.getRunProviderConfig(runId);
      if (!runProvider) {
        throw new Error(
          `运行 ${runId} 没有 provider 快照，无法安全恢复。请确认该运行是否正常启动过。`,
        );
      }
      const agentRuntime = createAgentAdapterFromSnapshot({
        snapshot: runProvider,
        repoPath,
        gateway,
      });

      if (args.values['approve-human']) {
        if (!decisionContext?.decisionId) {
          throw new Error(
            '无法推断待审批的人工决策，请使用 --run-id 和 --decision-id 参数指定',
          );
        }
        const decision =
          await repositories.getHumanDecision(
            decisionContext.decisionId,
          );
        if (!decision || decision.runId !== runId) {
          throw new Error(
            `未找到人工决策: ${decisionContext.decisionId}`,
          );
        }
        if (decision.status !== 'pending') {
          throw new Error(
            `决策 ${decisionContext.decisionId} 已经是 ${decision.status} 状态，无法再次操作`,
          );
        }
        const humanGate = createHumanGate({
          repositories,
        });
        await humanGate.approveHumanGate(
          decision.id,
          'cli',
          'approved by CLI',
        );
        await repositories.transitionNode(
          decision.nodeId,
          'awaiting-gate',
        );
        await audit.append({
          runId,
          type: 'human.gate.approved',
          payload: {
            decisionId: decision.id,
            nodeId: decision.nodeId,
          },
        });
      }

      const engine = createWorkflowEngine({
        repoPath,
        dataDir: '.tekon',
        repositories,
        audit,
        adapter: agentRuntime.adapter,
        agentProvider: agentRuntime.provider,
        agentConfigSummary: agentRuntime.configSummary,
        gateEngine: createGateEngine({
          repositories,
          gateway,
        }),
        worktreeManager: createWorktreeManager({
          repositories,
          gateway,
        }),
        builtInRolesDir: getBuiltInRolesDir(),
      });
      const result = await engine.resumeRun(runId);
      io.stdout.write(
        `runId=${runId} status=${result.workflow.status}\n`,
      );
    },
  );
}

export async function commandCancel(
  argv: string[],
  io: CliIO,
) {
  await withCommandCtx(
    argv,
    io,
    async ({ repos: repositories, runId }) => {
      const workflow =
        await repositories.getWorkflowInstance(runId);
      if (!workflow) {
        throw new Error(`未找到运行: ${runId}`);
      }
      if (workflow.currentNodeId) {
        await repositories.transitionNode(
          workflow.currentNodeId,
          'interrupted',
        );
      }
      const cancelled =
        await repositories.updateWorkflowInstanceStatus(
          runId,
          'cancelled',
          workflow.currentNodeId,
        );
      io.stdout.write(
        `runId=${runId} status=${cancelled?.status ?? 'cancelled'}\n`,
      );
    },
  );
}
