import { realpathSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  agentRequiresUnrestrictedNetwork,
  canonicalJson,
  loadWorkflowTemplate,
  captureRunPlan,
  generateDynamicWorkflow,
  getRunModePolicyIssue,
  readDraftShapeFile,
  renderDraftShapeForRun,
  saveDynamicTemplate,
  isValidRequestId,
  RunAdmissionError,
  type RunAdmissionEnvelope,
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
  explicitPathReference,
  resolveDemandShapePath,
  resolveProjectRepoPath,
} from '../lib/path-utils.js';
import {
  assertCleanBase,
  loadWorkflowByName,
  readConfigDefaultAgent,
} from '../lib/utils.js';

export async function commandRun(argv: string[], io: CliIO): Promise<number> {
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
      'request-id': { type: 'string' },
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
  if (
    args.values['request-id'] !== undefined &&
    !isValidRequestId(args.values['request-id'])
  ) {
    throw new Error(
      'REQUEST_ID_INVALID: requestId 必须为 8–128 位字母、数字、下划线或连字符',
    );
  }
  if (args.values.dynamic && args.values['request-id']) {
    throw new Error(
      'REQUEST_ID_UNSUPPORTED: 动态预览不受理 Run，不使用 --request-id',
    );
  }
  const repoPath = resolveProjectRepoPath(args.values.repo);
  const requestId = args.values.dynamic
    ? undefined
    : (args.values['request-id'] ?? randomUUID());
  if (requestId) io.stderr.write(`Request ID: ${requestId}\n`);
  await ensureInitialized(repoPath, io);
  const positionalDemandText = args.positionals.join(' ').trim();
  const suppliedDemandFile =
    args.values['draft-file'] ?? args.values['demand-file'];
  const allowDirtyBase = Boolean(args.values['allow-dirty-base']);

  function resolveDemand() {
    const demandFilePath = suppliedDemandFile
      ? resolveDemandShapePath(repoPath, suppliedDemandFile)
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
    return { demandText, shapedDemand, demandFilePath };
  }

  if (args.values.dynamic) {
    if (!args.values['dry-run'])
      throw new Error('动态工作流当前必须使用 --dry-run 参数运行');
    const { demandText } = resolveDemand();
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
        `mutations=${preview.constraints.mutations.map((mutation) => mutation.id).join(',')}`,
      ].join(' ') + '\n',
    );
    return 0;
  }

  const isGoal = Boolean(args.values.goal);
  const templateName = isGoal
    ? 'goal'
    : (args.values.template ?? 'standard-delivery');
  const runtime = providerRuntimeFromCliOptions(args.values);
  const demandIntent = suppliedDemandFile
    ? {
        kind: 'draft-reference',
        ...explicitPathReference(repoPath, suppliedDemandFile),
      }
    : positionalDemandText
      ? { kind: 'text', text: positionalDemandText }
      : { kind: 'latest-approved-draft' };
  const requestEnvelope: RunAdmissionEnvelope = {
    version: 1,
    scope: realpathSync(repoPath),
    surface: 'cli',
    demandTextOrRef: JSON.stringify(demandIntent),
    mode: isGoal ? 'goal' : 'workflow',
    templateName,
    requestedTemplate: args.values.template,
    profile: 'cli',
    // Default provider selection is resolved only for a fresh admission.
    agent: args.values.agent ?? '<configured-default>',
    allowDirtyBase,
    acknowledgeUnrestrictedNetwork: Boolean(
      args.values['acknowledge-unrestricted-network'],
    ),
    runtime,
  };

  return withCliSessionContext(repoPath, io, async (ctx) => {
    const lookupInput = { requestId: requestId!, requestEnvelope };
    let result;
    try {
      result = await ctx.sessionService.lookupRun(lookupInput);
      if (!result) {
        const { demandText } = resolveDemand();
        const agent =
          args.values.agent ?? readConfigDefaultAgent(repoPath) ?? 'codex';
        const runModeIssue = getRunModePolicyIssue({
          agent,
          kind: isGoal ? 'goal' : 'workflow',
          template: args.values.template,
        });
        if (runModeIssue) throw new Error(runModeIssue);
        const requiresUnrestrictedNetwork =
          agentRequiresUnrestrictedNetwork(agent);
        if (
          requiresUnrestrictedNetwork &&
          args.values['acknowledge-unrestricted-network'] !== true
        ) {
          throw new Error(
            `${agent} 联网不受 Tekon 限制。确认本次运行接受完整网络访问后，显式追加 --acknowledge-unrestricted-network。`,
          );
        }
        assertCleanBase(repoPath, allowDirtyBase);
        const template = isGoal
          ? loadWorkflowTemplate({ name: 'goal' })
          : loadWorkflowByName(
              templateName,
              join(repoPath, '.tekon', 'workflows'),
            );
        const runPlan = captureRunPlan(repoPath, template, {
          agent,
          profile: 'cli',
          allowDirtyBase,
          timeoutMs: runtime?.timeoutMs,
          noProgressTimeoutMs: runtime?.noProgressTimeoutMs,
          progressHeartbeatMs: runtime?.progressHeartbeatMs,
          templateId: templateName,
          templateVersion: template.version,
          mode: isGoal ? 'goal' : 'workflow',
        });
        result = await ctx.sessionService.startRun({
          requestId,
          requestEnvelope,
          demandText,
          mode: isGoal ? 'goal' : 'workflow',
          templateName,
          ...(isGoal ? {} : { workflowSpec: template }),
          planDigest: runPlan.digest,
          engine: {
            agent,
            allowDirtyBase,
            runtime,
            canonicalPlan: runPlan,
            planDigest: runPlan.digest,
            planSnapshot: canonicalJson(runPlan),
          },
          admissionAudits: requiresUnrestrictedNetwork
            ? [
                {
                  type: 'run.network-acknowledged',
                  payload: {
                    agent,
                    surface: 'cli',
                    acknowledgement: '--acknowledge-unrestricted-network',
                  },
                },
              ]
            : [],
        });
      }
    } catch (error) {
      try {
        result = await ctx.sessionService.lookupRun(lookupInput);
      } catch (lookupError) {
        if (
          lookupError instanceof Error &&
          lookupError.message.startsWith('REQUEST_ID_CONFLICT')
        ) {
          throw new Error(`REQUEST_ID_CONFLICT: requestId=${requestId}`);
        }
        // A competing process may have admitted the request since the first
        // lookup. Prefer its durable identity over the earlier preflight error.
        if (lookupError instanceof RunAdmissionError && lookupError.runId) {
          throw lookupError;
        }
      }
      if (!result) {
        throw new Error(
          `${error instanceof Error ? error.message : '受理状态待确认'} (requestId=${requestId})`,
        );
      }
    }

    if (result.admissionState !== 'ready') {
      io.stdout.write(
        `Run ID: ${result.runId}\nSession ID: ${result.sessionId}\n状态: ${result.admissionState === 'pending' ? '已受理，等待目录就绪' : '已受理，等待目录恢复；任务尚未执行'}\n`,
      );
      io.stderr.write(
        `ADMISSION_RECOVERY_REQUIRED: requestId=${requestId}，修复目录准备问题后以相同请求重试。\n`,
      );
      return 1;
    }
    ctx.jobRunner.start();
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

    const workflow = await ctx.repositories.getWorkflowInstance(result.runId);
    const status = workflow?.status ?? result.workflow.status;
    const pendingHuman = (
      await ctx.repositories.listHumanDecisions(result.runId)
    ).filter((decision) => decision.status === 'pending');
    io.stdout.write(
      [
        result.replayed ? '↩ 已受理请求，继续观察原运行' : '🚀 运行已启动',
        `  Run ID: ${result.runId}`,
        `  状态: ${status}`,
        `  模板: ${templateName}`,
        pendingHuman.length > 0 ? '  人工确认: pending' : '',
        '后续操作:',
        '  tekon status          查看运行状态',
        '  tekon review          查看审阅面板',
      ]
        .filter(Boolean)
        .join('\n') + '\n',
    );
    return exitCodeForWorkflowStatus(status);
  });
}

export function createDynamicMockAdapter(demandText: string) {
  return {
    async runAgent(input: { outputDir: string }): Promise<{
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
