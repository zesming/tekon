import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  agentRequiresUnrestrictedNetwork,
  canonicalJson,
  loadWorkflowTemplate,
  projectRunPlan,
  generateDynamicWorkflow,
  getRunModePolicyIssue,
  readDraftShapeFile,
  renderDraftShapeForRun,
  saveDynamicTemplate,
} from '@tekon/core';

import { providerRuntimeFromCliOptions } from '../lib/agent-factory.js';
import type { CliIO } from '../lib/context.js';
import { ensureInitialized } from '../lib/context.js';
import {
  awaitJobTerminal,
  exitCodeForWorkflowStatus,
  withCliSessionContext,
} from '../lib/session-context.js';
import {
  resolveDemandShapePath,
  resolveProjectRepoPath,
} from '../lib/path-utils.js';
import {
  assertCleanBase,
  loadWorkflowByName,
  readConfigDefaultAgent,
} from '../lib/utils.js';

export async function commandRun(
  argv: string[],
  io: CliIO,
): Promise<number> {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      template: { type: 'string' },
      agent: { type: 'string' },
      goal: { type: 'boolean', default: false },
      dynamic: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'allow-dirty-base': { type: 'boolean', default: false },
      'acknowledge-unrestricted-network': {
        type: 'boolean',
        default: false,
      },
      'save-as': { type: 'string' },
      'draft-file': { type: 'string' },
      'demand-file': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'no-progress-timeout-ms': { type: 'string' },
      'progress-heartbeat-ms': { type: 'string' },
    },
    allowPositionals: true,
  });
  // Never silently turn a preview request into a real run. The only current
  // preview implementation is the dynamic branch below; reject all other
  // dry-run requests before initialization, provider setup or persistence.
  if (args.values['dry-run'] && !args.values.dynamic) {
    throw new Error(
      'DRY_RUN_UNSUPPORTED: --dry-run 当前仅支持 --dynamic；本次未初始化项目或启动运行。',
    );
  }
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  const positionalDemandText = args.positionals.join(' ').trim();
  const demandFilePath =
    args.values['draft-file'] ?? args.values['demand-file']
      ? resolveDemandShapePath(
          repoPath,
          args.values['draft-file'] ?? args.values['demand-file'],
        )
      : positionalDemandText
        ? null
        : resolveDemandShapePath(repoPath, undefined, {
            latestMustBeApproved: true,
          });
  const shapedDemand = demandFilePath
    ? readDraftShapeFile(demandFilePath)
    : null;
  if (shapedDemand && !shapedDemand.approved) {
    throw new Error(`需求草案必须先批准才能运行: ${demandFilePath}`);
  }
  // 4f-2: a draft with a generated plan (hasPlan) must be plan-approved before
  // run. Old drafts (no hasPlan) are exempt — the existing approve→run path is
  // unaffected. This mirrors the web project.run gate so `tekon draft
  // plan-approve` is a real, enforced step and not decorative.
  if (shapedDemand?.hasPlan && shapedDemand.planApproved !== true) {
    throw new Error(
      `需求草案已生成计划，必须先审批计划才能运行（tekon draft plan-approve）: ${demandFilePath}`,
    );
  }
  const demandText = shapedDemand
    ? renderDraftShapeForRun(shapedDemand)
    : positionalDemandText;
  if (!demandText) {
    throw new Error(
      '请提供需求文本或已批准的需求卡。示例: tekon run "你的需求" 或先执行 tekon draft new 创建需求草案。',
    );
  }
  const allowDirtyBase = Boolean(args.values['allow-dirty-base']);

  if (args.values.dynamic) {
    if (!args.values['dry-run']) {
      throw new Error('动态工作流当前必须使用 --dry-run 参数运行');
    }
    const preview = await generateDynamicWorkflow({
      demandText,
      repoPath,
      adapter: createDynamicMockAdapter(demandText),
    });
    if (args.values['save-as']) {
      saveDynamicTemplate(preview.draft, args.values['save-as'], {
        workflowsDir: join(repoPath, '.tekon', 'workflows'),
      });
    }
    io.stdout.write(
      [
        'dryRun=true',
        `phases=${preview.workflow.phases.length}`,
        `mutations=${preview.constraints.mutations
          .map((mutation) => mutation.id)
          .join(',')}`,
      ].join(' ') + '\n',
    );
    return 0;
  }

  // 4c (design §4.2): run goes through SessionService + an embedded job
  // runner. The job is awaited to a terminal state before the process exits
  // ("跑完即退出" preserved); the printed status is the WORKFLOW status (the
  // executor settles the job `done` when the engine pauses at a gate), and
  // the exit code follows the workflow's terminal status.
  const isGoal = Boolean(args.values.goal);
  const configDefaultAgent = readConfigDefaultAgent(repoPath);
  const agent = args.values.agent ?? configDefaultAgent ?? 'codex';
  const runModeIssue = getRunModePolicyIssue({
    agent,
    kind: isGoal ? 'goal' : 'workflow',
    template: args.values.template,
  });
  if (runModeIssue) {
    throw new Error(runModeIssue);
  }

  const requiresUnrestrictedNetwork =
    agentRequiresUnrestrictedNetwork(agent);
  if (
    requiresUnrestrictedNetwork &&
    args.values['acknowledge-unrestricted-network'] !== true
  ) {
    throw new Error(
      `${agent} 联网不受 Tekon 限制。确认本次运行接受完整网络访问后，` +
        '显式追加 --acknowledge-unrestricted-network。',
    );
  }

  // Provider/mode and informed-consent checks happen before any workflow,
  // Session, Job or clean-base side effect. Runtime overrides carry the same
  // acknowledgement into the provider capability guard.
  assertCleanBase(repoPath, allowDirtyBase);

  const templateName = isGoal
    ? 'goal'
    : (args.values.template ?? 'standard-delivery');
  const runtime = providerRuntimeFromCliOptions(args.values);

  return withCliSessionContext(repoPath, io, async (ctx) => {
    const projectWorkflowsDir = join(repoPath, '.tekon', 'workflows');
    const template = isGoal
      ? loadWorkflowTemplate({ name: 'goal' })
      : loadWorkflowByName(templateName, projectWorkflowsDir);

    const runPlan = projectRunPlan(template, {
      agent,
      profile: 'cli',
      allowDirtyBase,
      timeoutMs: runtime?.timeoutMs,
      noProgressTimeoutMs: runtime?.noProgressTimeoutMs,
      progressHeartbeatMs: runtime?.progressHeartbeatMs,
      templateId: template.id,
      templateVersion: template.version,
      mode: isGoal ? ('goal' as const) : ('workflow' as const),
    });

    const result = await ctx.sessionService.startRun({
      demandText,
      ...(isGoal
        ? { mode: 'goal' as const }
        : { templateName, workflowSpec: template }),
      planDigest: runPlan.digest,
      engine: {
        agent,
        allowDirtyBase,
        runtime,
        canonicalPlan: runPlan,
        planDigest: runPlan.digest,
        planSnapshot: canonicalJson(runPlan),
      },
      ...(requiresUnrestrictedNetwork
        ? {
            onPrepared: async (runId: string) => {
              await ctx.audit.append({
                runId,
                type: 'run.network-acknowledged',
                payload: {
                  agent,
                  surface: 'cli',
                  acknowledgement:
                    '--acknowledge-unrestricted-network',
                },
              });
            },
          }
        : {}),
    });

    ctx.jobRunner.start();
    // S9: same-process cancel chain — Ctrl+C aborts the in-process controller
    // and kills this process's subprocesses (registry.killAll) instead of
    // waiting for the job lease to expire.
    const onSigint = () => {
      void ctx.jobRunner
        .requestCancel(result.jobId, 'cli SIGINT')
        .catch(() => {});
    };
    process.on('SIGINT', onSigint);
    try {
      await awaitJobTerminal({
        jobs: ctx.jobs,
        jobRunner: ctx.jobRunner,
        jobId: result.jobId,
      });
    } finally {
      process.removeListener('SIGINT', onSigint);
    }

    // S3: re-read the workflow instance — job terminal ≠ workflow terminal.
    const workflow = await ctx.repositories.getWorkflowInstance(result.runId);
    const status = workflow?.status ?? result.workflow.status;
    const pendingHuman = (
      await ctx.repositories.listHumanDecisions(result.runId)
    ).filter((decision) => decision.status === 'pending');
    io.stdout.write(
      [
        '🚀 运行已启动',
        `  Run ID: ${result.runId}`,
        `  状态: ${status}`,
        `  模板: ${templateName}`,
        pendingHuman.length > 0 ? '  人工确认: pending' : '',
        '',
        '后续操作:',
        '  tekon status          查看运行状态',
        '  tekon review          查看审阅面板',
        '',
      ]
        .filter((l) => l !== '')
        .join('\n') + '\n',
    );
    return exitCodeForWorkflowStatus(status);
  });
}

export function createDynamicMockAdapter(demandText: string) {
  return {
    async runAgent(input: {
      outputDir: string;
    }): Promise<{
      provider: 'mock';
      exitCode: number;
      durationMs: number;
      outputFiles: string[];
      timedOut: false;
    }> {
      const outputPath = join(input.outputDir, 'workflow-spec.json');
      const highRisk = /高风险|high-risk|risk/u.test(demandText);
      const dataRisk = /数据|退款|data|migration/u.test(demandText);
      writeFileSync(
        outputPath,
        JSON.stringify({
          demandSummary: demandText.slice(0, 80),
          phases: [
            {
              id: 'rd',
              name: 'RD',
              nodes: [
                {
                  id: 'rd-dynamic-implementation',
                  role: 'rd',
                  artifactOutputs: ['code-changes'],
                  gates: [{ type: 'build' }, { type: 'lint' }],
                },
              ],
            },
            {
              id: 'validation',
              name: 'Validation',
              dependsOn: ['rd'],
              nodes: [
                {
                  id: 'qa-dynamic-validation',
                  role: 'qa',
                  dependsOn: ['rd-dynamic-implementation'],
                  artifactOutputs: ['test-report'],
                  gates: [{ type: 'test' }],
                },
              ],
            },
            {
              id: 'reviewer',
              name: 'Independent Review',
              dependsOn: ['validation'],
              nodes: [
                {
                  id: 'reviewer-dynamic-review',
                  role: 'reviewer',
                  dependsOn: ['qa-dynamic-validation'],
                  artifactOutputs: ['review-report'],
                  gates: [{ type: 'human' }],
                },
              ],
            },
          ],
          riskTags: [
            ...(highRisk ? ['high-risk'] : []),
            ...(dataRisk ? ['data'] : []),
          ],
          ...(highRisk ? { riskLevel: 'high' } : {}),
          assumptions: ['mock dynamic workflow preview'],
          openQuestions: [],
        }),
        'utf8',
      );
      return {
        provider: 'mock',
        exitCode: 0,
        durationMs: 1,
        outputFiles: [outputPath],
        timedOut: false,
      };
    },
  };
}
