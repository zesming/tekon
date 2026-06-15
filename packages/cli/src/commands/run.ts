import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createWorktreeManager,
  createWorkflowEngine,
  generateDynamicWorkflow,
  readDemandShapeFile,
  renderDemandShapeForRun,
  saveDynamicTemplate,
} from '@tekon/core';

import {
  createAgentAdapter,
  providerRuntimeFromCliOptions,
} from '../lib/agent-factory.js';
import type { CliIO } from '../lib/context.js';
import {
  ensureInitialized,
  withProjectContext,
} from '../lib/context.js';
import {
  resolveDemandShapePath,
  resolveProjectRepoPath,
} from '../lib/path-utils.js';
import {
  assertCleanBase,
  getBuiltInRolesDir,
  readConfigDefaultAgent,
} from '../lib/utils.js';

export async function commandRun(
  argv: string[],
  io: CliIO,
) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      template: { type: 'string' },
      agent: { type: 'string' },
      dynamic: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'allow-dirty-base': { type: 'boolean', default: false },
      'save-as': { type: 'string' },
      'draft-file': { type: 'string' },
      'demand-file': { type: 'string' },
      'timeout-ms': { type: 'string' },
      'no-progress-timeout-ms': { type: 'string' },
      'progress-heartbeat-ms': { type: 'string' },
    },
    allowPositionals: true,
  });
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
    ? readDemandShapeFile(demandFilePath)
    : null;
  if (shapedDemand && !shapedDemand.approved) {
    throw new Error(
      `需求草案必须先批准才能运行: ${demandFilePath}`,
    );
  }
  const demandText = shapedDemand
    ? renderDemandShapeForRun(shapedDemand)
    : positionalDemandText;
  if (!demandText) {
    throw new Error(
      '请提供需求文本或已批准的需求卡。示例: tekon run "你的需求" 或先执行 tekon draft new 创建需求草案。',
    );
  }
  const allowDirtyBase = Boolean(args.values['allow-dirty-base']);

  if (args.values.dynamic) {
    if (!args.values['dry-run']) {
      throw new Error(
        '动态工作流当前必须使用 --dry-run 参数运行',
      );
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
    return;
  }

  assertCleanBase(repoPath, allowDirtyBase);

  await withProjectContext(
    repoPath,
    async ({ db, repos: repositories }) => {
      const audit = createAuditLogger({ repositories });
      const gateway = createCommandGateway({ repositories });
      const configDefaultAgent = readConfigDefaultAgent(repoPath);
      const agentRuntime = createAgentAdapter({
        agent:
          args.values.agent ?? configDefaultAgent ?? 'codex',
        repoPath,
        gateway,
        runtime: providerRuntimeFromCliOptions(args.values),
      });
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
        allowDirtyBase,
        builtInRolesDir: getBuiltInRolesDir(),
      });

      const templateName =
        args.values.template ?? 'standard-delivery';
      const result = await engine.startRun({
        demandText,
        mode: 'template',
        templateName,
      });
      const pendingHuman = (
        await repositories.listHumanDecisions(result.runId)
      ).filter((decision) => decision.status === 'pending');
      io.stdout.write(
        [
          '🚀 运行已启动',
          `  Run ID: ${result.runId}`,
          `  状态: ${result.workflow.status}`,
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
    },
  );
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
      const outputPath = join(
        input.outputDir,
        'workflow-spec.json',
      );
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
                  gates: [
                    { type: 'build' },
                    { type: 'lint' },
                  ],
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
