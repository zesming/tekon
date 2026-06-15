#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  createAuditLogger,
  createClaudeCodeAdapter,
  createCodexAdapter,
  createCommandGateway,
  createDeliveryEvidencePackage,
  createGateEngine,
  createHumanGate,
  createHumanApprovalSummary,
  createMockAgentAdapter,
  createPullRequestPreparation,
  queryPullRequestCiStatus,
  createWorkReviewSurface,
  createRepositories,
  createScmDelivery,
  createWorktreeManager,
  createWorkflowEngine,
  evaluateWorkReadiness,
  evaluateWorkUsability,
  evaluateHumanApprovalSummary,
  approveDemandShape,
  evaluateDemandShape,
  evaluateWorkflowSelection,
  readDemandShapeFile,
  watchPullRequestCiStatus,
  renderDemandShapeForRun,
  renderWorkUsabilityEvaluationReport,
  selectWorkflowTemplateForDemand,
  shapeDemand,
  writeDemandShapeFile,
  writeDemandShapeFiles,
  loadRepoProfile,
  writeDefaultRepoProfile,
  generateDynamicWorkflow,
  listRoleIds,
  loadRole,
  loadWorkflowTemplate,
  migrateDatabase,
  openTekonDatabase,
  saveDynamicTemplate,
  repoProfileCommandGuidance,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
  workUsabilitySampleSetSchema,
  upsertWorkUsabilitySample,
  type AgentAdapter,
  type AgentAdapterConfig,
  agentAdapterConfigSchema,
  type CommandGateway,
  type DemandShape,
  type TekonRepositories,
  type RunProviderConfig,
  type TekonDatabase,
  type WorkUsabilitySample,
  type WorkUsabilitySampleSet,
} from '@tekon/core';

export interface CliIO {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

interface CommandMeta {
  name: string;
  aliases?: string[];
  description: string;
  group: string;
  subcommands?: Array<{ name: string; description: string }>;
  usage?: string;
}

const COMMANDS: CommandMeta[] = [
  // 项目管理
  { name: 'init', description: '初始化 Tekon 项目', group: '项目管理' },
  { name: 'draft', aliases: ['demand'], description: '创建和管理需求草案', group: '项目管理', subcommands: [
    { name: 'new', description: '创建新的需求草案' },
    { name: 'shape', description: '快速生成需求草案' },
    { name: 'approve', description: '批准需求草案' },
    { name: 'show', description: '查看需求草案详情' },
  ] },
  // 运行控制
  { name: 'run', description: '启动一次交付运行', group: '运行控制', usage: 'tekon run [需求文本] [options]' },
  { name: 'status', description: '查看运行状态', group: '运行控制' },
  { name: 'pause', description: '暂停运行', group: '运行控制' },
  { name: 'resume', description: '恢复暂停的运行', group: '运行控制' },
  { name: 'cancel', description: '取消运行', group: '运行控制' },
  // 工作流与角色
  { name: 'workflow', description: '管理工作流模板', group: '工作流与角色', subcommands: [
    { name: 'list', description: '列出所有工作流模板' },
    { name: 'show', description: '查看工作流模板详情' },
    { name: 'create', description: '从模板创建新工作流' },
    { name: 'select', description: '为需求选择合适的工作流' },
    { name: 'preflight', description: '检查工作流门的命令可用性' },
  ] },
  { name: 'role', description: '管理角色定义', group: '工作流与角色', subcommands: [
    { name: 'list', description: '列出所有角色' },
    { name: 'show', description: '查看角色详情' },
    { name: 'path', description: '显示角色目录路径' },
    { name: 'create', description: '从内置角色复制创建自定义角色' },
  ] },
  { name: 'constraints', description: '查看 Tekon 约束配置', group: '工作流与角色' },
  // 交付
  { name: 'delivery', description: '准备和创建交付 PR', group: '交付', subcommands: [
    { name: 'prepare', description: '准备交付 PR' },
    { name: 'create-pr', description: '创建 PR' },
    { name: 'ci-status', description: '查询 PR 的 CI 状态' },
    { name: 'ci-watch', description: '持续观察 PR 的 CI 状态直到完成' },
  ] },
  { name: 'approval', description: '管理人工审批', group: '交付', subcommands: [
    { name: 'summary', description: '生成审批摘要' },
    { name: 'reject', description: '拒绝人工审批' },
  ] },
  // 审阅与评估
  { name: 'review', description: '生成运行审阅报告', group: '审阅与评估' },
  { name: 'eval', description: '评估运行质量与准备度', group: '审阅与评估', subcommands: [
    { name: 'readiness', description: '评估工作准备度' },
    { name: 'demand-shape', description: '评估需求草案质量' },
    { name: 'workflow-selection', description: '评估工作流选择合理性' },
    { name: 'approval-summary', description: '评估审批摘要质量' },
    { name: 'work-usability', description: '评估工作可用性' },
  ] },
  { name: 'log', description: '查看运行审计日志', group: '审阅与评估' },
  // 工具
  { name: 'clean', description: '清理工作树', group: '工具' },
  { name: 'ui', description: '启动 Web 管理界面', group: '工具' },
  { name: 'update', description: '更新 Tekon CLI', group: '工具' },
];

export async function runCli(
  argv: string[] = process.argv.slice(2),
  io: CliIO = process,
): Promise<number> {
  try {
    const [command, ...rest] = argv;

    // --help / -h 作为第一个参数显示命令概览
    if (command === '--help' || command === '-h') {
      return await commandHelp([], io);
    }

    // --version / -v 显示版本号
    if (command === '--version' || command === '-v') {
      io.stdout.write(`v${getVersion()}\n`);
      return 0;
    }

    if (!command) {
      io.stderr.write('用法: tekon <command>\n');
      io.stderr.write('使用 tekon help 查看所有可用命令。\n');
      return 1;
    }

    switch (command) {
      case 'init':
        await commandInit(rest, io);
        return 0;
      case 'run':
        await commandRun(rest, io);
        return 0;
      case 'draft':
      case 'demand':
        await commandDemand(rest, io);
        return 0;
      case 'status':
        await commandStatus(rest, io);
        return 0;
      case 'pause':
        await commandPause(rest, io);
        return 0;
      case 'resume':
        await commandResume(rest, io);
        return 0;
      case 'cancel':
        await commandCancel(rest, io);
        return 0;
      case 'role':
        await commandRole(rest, io);
        return 0;
      case 'workflow':
        await commandWorkflow(rest, io);
        return 0;
      case 'constraints':
        await commandConstraints(rest, io);
        return 0;
      case 'delivery':
        await commandDelivery(rest, io);
        return 0;
      case 'approval':
        await commandApproval(rest, io);
        return 0;
      case 'eval':
        await commandEval(rest, io);
        return 0;
      case 'review':
        await commandReview(rest, io);
        return 0;
      case 'log':
        await commandLog(rest, io);
        return 0;
      case 'clean':
        await commandClean(rest, io);
        return 0;
      case 'ui':
        await commandUi(rest, io);
        return 0;
      case 'update':
        await commandUpdate(rest, io);
        return 0;
      case 'help':
        return await commandHelp(rest, io);
      default:
        io.stderr.write(`未知命令: ${command}\n`);
        io.stderr.write('使用 tekon help 查看可用命令。\n');
        return 1;
    }
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCli();
  process.exitCode = exitCode;
}

function getVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function commandHelp(argv: string[], io: CliIO): Promise<number> {
  const [subcommand] = argv;

  if (subcommand === '--help') {
    io.stdout.write('tekon help — 显示所有可用命令及其简要说明\n\n');
    io.stdout.write('用法: tekon help [command]\n\n');
    io.stdout.write('不指定命令时，显示所有一级命令及分组。\n');
    io.stdout.write('指定命令时，显示该命令的子命令和用法。\n');
    return 0;
  }

  if (subcommand) {
    return writeCommandHelp(subcommand, io);
  }

  writeGeneralHelp(io);
  return 0;
}

function writeGeneralHelp(io: CliIO): void {
  const version = getVersion();
  const lines: string[] = [];

  lines.push(`Tekon CLI v${version} — AI 驱动的软件交付自动化工具`);
  lines.push('');
  lines.push('用法: tekon <command> [options]');
  lines.push('');

  const groups = new Map<string, typeof COMMANDS>();
  for (const cmd of COMMANDS) {
    const list = groups.get(cmd.group) ?? [];
    list.push(cmd);
    groups.set(cmd.group, list);
  }

  for (const [group, commands] of groups) {
    lines.push(`  ${group}`);
    for (const cmd of commands) {
      const label = cmd.aliases?.length
        ? `${cmd.name}（别名: ${cmd.aliases.join(', ')}）`
        : cmd.name;
      lines.push(`    ${label.padEnd(22)}${cmd.description}`);
    }
    lines.push('');
  }

  lines.push('使用 tekon help <command> 查看特定命令的详细帮助。');

  io.stdout.write(lines.join('\n') + '\n');
}

function writeCommandHelp(commandName: string, io: CliIO): number {
  const cmd = COMMANDS.find(
    (c) => c.name === commandName || (c.aliases?.includes(commandName) ?? false),
  );

  if (!cmd) {
    io.stderr.write(`未知命令: ${commandName}\n`);
    io.stderr.write('使用 tekon help 查看可用命令。\n');
    return 1;
  }

  const lines: string[] = [];
  const aliasSuffix = cmd.aliases?.length
    ? `（别名: ${cmd.aliases.join(', ')}）`
    : '';
  lines.push(`tekon ${cmd.name} — ${cmd.description}${aliasSuffix}`);
  lines.push('');

  if (cmd.usage) {
    lines.push(`用法: ${cmd.usage}`);
    lines.push('');
  }

  if (cmd.subcommands?.length) {
    lines.push('子命令:');
    for (const sub of cmd.subcommands) {
      lines.push(`  ${sub.name.padEnd(16)}${sub.description}`);
    }
    lines.push('');
  }

  io.stdout.write(lines.join('\n') + '\n');
  return 0;
}

async function commandInit(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveRepoPathForInit(args.values.repo);
  initializeProject(repoPath, io);
}

async function commandRun(argv: string[], io: CliIO) {
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
  const demandFilePath = (args.values['draft-file'] ?? args.values['demand-file'])
    ? resolveDemandShapePath(repoPath, (args.values['draft-file'] ?? args.values['demand-file']))
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
      `draft file must be approved before run: ${demandFilePath}`,
    );
  }
  const demandText = shapedDemand
    ? renderDemandShapeForRun(shapedDemand)
    : positionalDemandText;
  if (!demandText) {
    throw new Error('run draft text is required');
  }
  const allowDirtyBase = Boolean(args.values['allow-dirty-base']);

  if (args.values.dynamic) {
    if (!args.values['dry-run']) {
      throw new Error('dynamic workflow currently requires --dry-run');
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

  await withProjectContext(repoPath, async ({ db, repos: repositories }) => {
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const configDefaultAgent = readConfigDefaultAgent(repoPath);
    const agentRuntime = createAgentAdapter({
      agent: args.values.agent ?? configDefaultAgent ?? 'codex',
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
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
      allowDirtyBase,
      builtInRolesDir: getBuiltInRolesDir(),
    });

    const result = await engine.startRun({
      demandText,
      mode: 'template',
      templateName: args.values.template ?? 'standard-delivery',
    });
    const pendingHuman = (
      await repositories.listHumanDecisions(result.runId)
    ).filter((decision) => decision.status === 'pending');
    io.stdout.write(
      [
        `runId=${result.runId}`,
        `status=${result.workflow.status}`,
        pendingHuman.length > 0 ? 'humanGate=pending' : 'humanGate=none',
      ].join(' ') + '\n',
    );
  });
}

function createDynamicMockAdapter(demandText: string) {
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

async function commandDemand(argv: string[], io: CliIO) {
  const [subcommand, ...rest] = argv;

  if (subcommand === 'new') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'no-interactive': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const demandText = args.positionals.join(' ').trim();
    if (!demandText) {
      throw new Error(
        '请提供需求文本。示例: tekon draft new "新增用户认证系统，支持 OAuth2.0 和邮箱密码登录"',
      );
    }

    // Spinner while initial shaping
    process.stderr.write('正在分析需求');
    const spinnerChars = ['.', '..', '...'];
    let spinnerIdx = 0;
    const spinnerInterval = setInterval(() => {
      process.stderr.write(
        `\r正在分析需求${spinnerChars[spinnerIdx % spinnerChars.length]}`,
      );
      spinnerIdx++;
    }, 300);

    const initialShape = shapeDemand({ text: demandText });

    clearInterval(spinnerInterval);
    process.stderr.write('\r正在分析需求 完成\n');

    const repoPath = resolveProjectRepoPath(args.values.repo);
    await ensureInitialized(repoPath, io);

    // Interactive clarification (skip with --no-interactive or non-TTY)
    let shape = initialShape;
    if (!args.values['no-interactive']) {
      const { runInteractiveClarification } = await import(
        './draft-interactive.js'
      );
      const agentCmd = resolveAgentCommand(repoPath);
      const agentConfig = agentCmd
        ? { agentCommand: agentCmd, repoPath }
        : undefined;
      const result = await runInteractiveClarification(
        shape,
        readStdinLine,
        io.stdout,
        agentConfig,
      );
      shape = result.draft;
      if (result.interrupted) {
        io.stdout.write('\n交互已取消，保留已填写的内容。\n');
      }
    }

    // Write files
    const paths = writeDemandShapeFiles({ repoPath, shape });

    // Human-readable output
    if (args.values.json) {
      io.stdout.write(
        `${JSON.stringify({ shape, ...paths }, null, 2)}\n`,
      );
      return;
    }

    const categoryMap: Record<string, string> = {
      feature: '功能', bugfix: '缺陷修复', test: '测试',
      docs: '文档', refactor: '重构', other: '其他',
    };
    const riskMap: Record<string, string> = {
      low: '低风险', medium: '中风险', high: '高风险',
    };

    const lines: string[] = [];
    lines.push('📄 需求草案已保存');
    lines.push(`   文件: ${paths.markdownPath}`);
    lines.push('');
    lines.push(`标题: ${shape.title}`);
    lines.push(`类别: ${categoryMap[shape.category] ?? shape.category}`);
    lines.push(`风险: ${riskMap[shape.risk.level] ?? shape.risk.level}`);
    lines.push(`模板: ${shape.recommendedTemplate}`);
    lines.push(`审批: ${shape.approved ? '已审批' : '未审批'}`);

    if (shape.acceptanceCriteria.length > 0) {
      lines.push('', '验收标准:');
      for (const ac of shape.acceptanceCriteria) {
        lines.push(`  ${ac.id}: ${ac.description}`);
      }
    }

    lines.push('', '后续操作:');
    lines.push('  tekon draft review      评审草案');
    lines.push('  tekon draft approve     批准后即可执行');
    lines.push(`  tekon run --draft-file ${paths.jsonPath}    发起运行`);
    lines.push('');

    io.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (subcommand === 'shape') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        write: { type: 'boolean', default: false },
        'no-write': { type: 'boolean', default: false },
        format: { type: 'string' },
      },
      allowPositionals: true,
    });
    const demandText = args.positionals.join(' ').trim();
    const shape = shapeDemand({ text: demandText });
    const repoPath = resolveProjectRepoPath(args.values.repo);
    const shouldWrite = !args.values['no-write'];
    if (shouldWrite) {
      await ensureInitialized(repoPath, io);
    }
    const paths = shouldWrite
      ? writeDemandShapeFiles({ repoPath, shape })
      : null;
    if (args.values.format === 'json') {
      io.stdout.write(
        `${JSON.stringify({ shape, ...(paths ?? {}) }, null, 2)}\n`,
      );
      return;
    }
    io.stdout.write(
      [
        `draftId=${shape.id}`,
        `readyForRun=${shape.readyForRun}`,
        `approved=${shape.approved}`,
        `category=${shape.category}`,
        `risk=${shape.risk.level}`,
        `recommendedTemplate=${shape.recommendedTemplate}`,
        `openQuestions=${shape.openQuestions.length}`,
        paths ? `shapePath=${paths.jsonPath}` : '',
        paths ? `reviewPath=${paths.markdownPath}` : '',
      ]
        .filter(Boolean)
        .join(' ') + '\n',
    );
    return;
  }

  if (subcommand === 'approve') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        shape: { type: 'string' },
        actor: { type: 'string' },
      },
      allowPositionals: true,
    });
    const shapeArg = args.values.shape ?? args.positionals[0];
    const repoPath = resolveProjectRepoPath(args.values.repo);
    if (!shapeArg) {
      await ensureInitialized(repoPath, io);
    }
    const shapePath = resolveDemandShapePath(repoPath, shapeArg, {
      latestMustBeUnapproved: !shapeArg,
    });
    const approved = approveDemandShape(readDemandShapeFile(shapePath), {
      actor: args.values.actor ?? 'cli',
    });
    writeDemandShapeFile(shapePath, approved);
    io.stdout.write(
      [
        `draftId=${approved.id}`,
        `approved=${approved.approved}`,
        `approvedBy=${approved.approvedBy ?? ''}`,
        `approvedAt=${approved.approvedAt ?? ''}`,
        `shapePath=${shapePath}`,
      ].join(' ') + '\n',
    );
    return;
  }

  if (subcommand === 'show') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        shape: { type: 'string' },
        eval: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const shapeArg = args.values.shape ?? args.positionals[0];
    const repoPath = resolveProjectRepoPath(args.values.repo);
    if (!shapeArg) {
      await ensureInitialized(repoPath, io);
    }
    const shapePath = resolveDemandShapePath(repoPath, shapeArg);
    const shape = readDemandShapeFile(shapePath);
    const evaluation = evaluateDemandShape(shape);
    io.stdout.write(
      [
        `draftId=${shape.id}`,
        `title=${shape.title}`,
        `category=${shape.category}`,
        `risk=${shape.risk.level}`,
        `readyForRun=${shape.readyForRun}`,
        `approved=${shape.approved}`,
        `recommendedTemplate=${shape.recommendedTemplate}`,
        `acceptanceCriteria=${shape.acceptanceCriteria.length}`,
        `openQuestions=${shape.openQuestions.length}`,
        args.values.eval
          ? `evalReady=${evaluation.ready} evalScore=${evaluation.score.toFixed(2)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n') + '\n',
    );
    return;
  }

  throw new Error(`unknown draft command: ${subcommand ?? ''}`);
}

async function commandPause(argv: string[], io: CliIO) {
  await withCommandCtx(argv, io, async ({ repos: repositories, runId }) => {
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }
    if (workflow.currentNodeId) {
      await repositories.transitionNode(workflow.currentNodeId, 'paused');
    }
    const paused = await repositories.updateWorkflowInstanceStatus(
      runId,
      'paused',
      workflow.currentNodeId,
    );
    io.stdout.write(`runId=${runId} status=${paused?.status ?? 'paused'}\n`);
  });
}

async function commandResume(argv: string[], io: CliIO) {
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
  await withProjectContext(repoPath, async ({ db, repos: repositories }) => {
    let decisionContext: { runId: string; decisionId?: string } | null = null;
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
      throw new Error('run id could not be inferred; pass --run-id <runId>');
    }
    const audit = createAuditLogger({ repositories });
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }

    const gateway = createCommandGateway({ repositories });
    const runProvider = await repositories.getRunProviderConfig(runId);
    if (!runProvider) {
      throw new Error(
        `run ${runId} has no provider snapshot; cannot resume safely`,
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
          'pending human decision could not be inferred; pass --run-id and --decision-id',
        );
      }
      const decision = await repositories.getHumanDecision(
        decisionContext.decisionId,
      );
      if (!decision || decision.runId !== runId) {
        throw new Error(
          `human decision not found: ${decisionContext.decisionId}`,
        );
      }
      if (decision.status !== 'pending') {
        throw new Error(
          `decision is already ${decision.status}: ${decisionContext.decisionId}`,
        );
      }
      const humanGate = createHumanGate({ repositories });
      await humanGate.approveHumanGate(decision.id, 'cli', 'approved by CLI');
      await repositories.transitionNode(decision.nodeId, 'awaiting-gate');
      await audit.append({
        runId,
        type: 'human.gate.approved',
        payload: { decisionId: decision.id, nodeId: decision.nodeId },
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
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
      builtInRolesDir: getBuiltInRolesDir(),
    });
    const result = await engine.resumeRun(runId);
    io.stdout.write(`runId=${runId} status=${result.workflow.status}\n`);
  });
}

async function commandCancel(argv: string[], io: CliIO) {
  await withCommandCtx(argv, io, async ({ repos: repositories, runId }) => {
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }
    if (workflow.currentNodeId) {
      await repositories.transitionNode(workflow.currentNodeId, 'interrupted');
    }
    const cancelled = await repositories.updateWorkflowInstanceStatus(
      runId,
      'cancelled',
      workflow.currentNodeId,
    );
    io.stdout.write(
      `runId=${runId} status=${cancelled?.status ?? 'cancelled'}\n`,
    );
  });
}

async function commandRole(argv: string[], io: CliIO) {
  const [subcommand, roleId, ...rest] = argv;
  const args = parseArgs({
    args: rest,
    options: { repo: { type: 'string' } },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  const builtInRolesDir = getBuiltInRolesDir();

  if (subcommand === 'list') {
    const roles = new Set([
      ...listRoleIds(builtInRolesDir),
      ...listRoleIds(join(repoPath, '.tekon', 'roles')),
    ]);
    io.stdout.write(`${[...roles].sort().join('\n')}\n`);
    return;
  }

  if (!roleId) {
    throw new Error('role id is required');
  }
  ensureSafeName(roleId);
  const validRoles = ['pm', 'rd', 'qa', 'reviewer', 'pmo'] as const;
  if (!validRoles.includes(roleId as (typeof validRoles)[number])) {
    throw new Error(
      `invalid role id: ${roleId} (expected one of: ${validRoles.join(', ')})`,
    );
  }
  const role = roleId as (typeof validRoles)[number];

  if (subcommand === 'show') {
    const loadedRole = loadRole({ role, repoPath, builtInRolesDir });
    io.stdout.write(
      [
        `role=${loadedRole.role}`,
        `name=${loadedRole.agent.name ?? loadedRole.role}`,
        `source=${loadedRole.source}`,
        `skills=${loadedRole.skills.map((skill) => skill.id).join(',')}`,
      ].join('\n') + '\n',
    );
    return;
  }

  if (subcommand === 'path') {
    const loadedRole = loadRole({ role, repoPath, builtInRolesDir });
    io.stdout.write(`${loadedRole.roleDir}\n`);
    return;
  }

  if (subcommand === 'create') {
    await ensureInitialized(repoPath, io);
    const source = join(builtInRolesDir, roleId);
    const target = join(repoPath, '.tekon', 'roles', roleId);
    const resolvedBuiltInDir = realpathSync(builtInRolesDir);
    const resolvedSource = realpathSync(source);
    if (!resolvedSource.startsWith(resolvedBuiltInDir + '/')) {
      throw new Error(`role id escapes built-in roles directory: ${roleId}`);
    }
    const repoRolesDir = join(repoPath, '.tekon', 'roles');
    mkdirSync(repoRolesDir, { recursive: true });
    const resolvedRolesDir = realpathSync(repoRolesDir);
    const resolvedTarget = resolve(resolvedRolesDir, roleId);
    if (!resolvedTarget.startsWith(resolvedRolesDir + '/')) {
      throw new Error(`role id escapes project roles directory: ${roleId}`);
    }
    cpSync(resolvedSource, resolvedTarget, { recursive: true });
    io.stdout.write(`${resolvedTarget}\n`);
    return;
  }

  throw new Error(`unknown role command: ${subcommand ?? ''}`);
}

async function commandWorkflow(argv: string[], io: CliIO) {
  const [subcommand, name, ...rest] = argv;
  if (subcommand === 'select') {
    const selectArgs = parseArgs({
      args: argv.slice(1),
      options: {
        repo: { type: 'string' },
        shape: { type: 'string' },
        template: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(selectArgs.values.repo);
    const positionalDemandText = selectArgs.positionals.join(' ').trim();
    const shapePath = selectArgs.values.shape
      ? resolveDemandShapePath(repoPath, selectArgs.values.shape)
      : positionalDemandText
        ? null
        : resolveDemandShapePath(repoPath);
    const shape = shapePath ? readDemandShapeFile(shapePath) : null;
    const demandText = shape ? shape.rawText : positionalDemandText;
    const selection = selectWorkflowTemplateForDemand({
      text: demandText,
      ...(shape ? { category: shape.category } : {}),
    });
    const evaluation = evaluateWorkflowSelection({
      text: demandText,
      selectedTemplate:
        selectArgs.values.template ?? shape?.recommendedTemplate,
      ...(shape ? { category: shape.category } : {}),
    });
    if (selectArgs.values.json) {
      io.stdout.write(
        `${JSON.stringify({ selection, evaluation }, null, 2)}\n`,
      );
      return;
    }
    io.stdout.write(
      [
        `recommendedTemplate=${selection.recommendedTemplate}`,
        `category=${selection.category}`,
        `ready=${evaluation.ready}`,
        `score=${evaluation.score.toFixed(2)}`,
        `alternatives=${selection.alternatives.join(',')}`,
        `reasons=${selection.reasons.join('|')}`,
      ].join(' ') + '\n',
    );
    return;
  }

  const args = parseArgs({
    args: rest,
    options: {
      repo: { type: 'string' },
      from: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  const builtInWorkflowsDir = getBuiltInWorkflowsDir();
  const projectWorkflowsDir = join(repoPath, '.tekon', 'workflows');

  if (subcommand === 'list') {
    const names = new Set([
      ...listWorkflowNames(builtInWorkflowsDir),
      ...listWorkflowNames(projectWorkflowsDir),
    ]);
    io.stdout.write(`${[...names].sort().join('\n')}\n`);
    return;
  }

  if (subcommand === 'preflight') {
    const templateName = name ?? 'standard-delivery';
    const template = loadWorkflowByName(templateName, projectWorkflowsDir);
    const profile = loadRepoProfile(repoPath);
    for (const phase of template.phases) {
      for (const node of phase.nodes) {
        for (const gate of node.gates) {
          const guidance = gate.commandRef
            ? repoProfileCommandGuidance(repoPath, profile, gate.commandRef)
            : null;
          const command =
            gate.command ?? (guidance?.command ? guidance.command : null);
          const isCommandBackedGate = Boolean(
            gate.commandRef || gate.command || gate.type === 'security-scan',
          );
          const commandText = command
            ? [command.tool, ...command.args].join(' ')
            : gate.type === 'security-scan'
              ? 'tekon-builtin security scan'
              : '';
          const repoCommandNotApplicable =
            guidance?.status === 'not-applicable' &&
            gate.type !== 'security-scan';
          const status = !isCommandBackedGate
            ? 'not-command-gate'
            : repoCommandNotApplicable
              ? 'not-applicable'
              : commandText
                ? 'resolved'
                : 'missing';
          const fields = [
            `node=${node.id}`,
            `gate=${gate.type}`,
            gate.commandRef
              ? `commandRef=${gate.commandRef}`
              : 'commandRef=none',
            `status=${status}`,
            commandText ? `command=${commandText}` : 'command=',
          ];
          if (guidance?.status === 'not-applicable') {
            fields.push(`hint=${guidance.hint}`);
            fields.push(`profilePath=${guidance.profilePath}`);
            fields.push(`notApplicableReason=${guidance.reason ?? ''}`);
            if (gate.type === 'security-scan') {
              fields.push('notApplicableIgnoredFor=security-scan');
            }
          } else if (!commandText && guidance) {
            fields.push(`hint=${guidance.hint}`);
            fields.push(`profilePath=${guidance.profilePath}`);
            const suggestion = guidance.suggestions[0];
            if (suggestion) {
              fields.push(`suggestedScript=${suggestion.scriptName}`);
              fields.push(`suggestedCommand=${suggestion.commandText}`);
            }
          }
          io.stdout.write(fields.join(' ') + '\n');
        }
      }
    }
    return;
  }

  if (!name) {
    throw new Error('workflow name is required');
  }

  if (subcommand === 'show') {
    const template = loadWorkflowByName(name, projectWorkflowsDir);
    io.stdout.write(
      `id=${template.id}\nname=${template.name}\nphases=${template.phases.length}\n`,
    );
    return;
  }

  if (subcommand === 'create') {
    ensureSafeName(name);
    await ensureInitialized(repoPath, io);
    const fromName = args.values.from ?? 'standard-delivery';
    ensureSafeName(fromName);
    const source = getWorkflowFilePath(fromName, projectWorkflowsDir);
    const target = join(projectWorkflowsDir, `${name}.yaml`);
    mkdirSync(projectWorkflowsDir, { recursive: true });
    const content = readFileSync(source, 'utf8').replace(
      /^id:\s*.+$/mu,
      `id: ${name}`,
    );
    writeFileSync(target, content, 'utf8');
    io.stdout.write(`${target}\n`);
    return;
  }

  throw new Error(`unknown workflow command: ${subcommand ?? ''}`);
}

async function commandConstraints(argv: string[], io: CliIO) {
  const [subcommand] = argv;
  if (subcommand !== 'show') {
    throw new Error(`unknown constraints command: ${subcommand ?? ''}`);
  }
  io.stdout.write(
    readFileSync(join(getRepoRoot(), 'constraints.yaml'), 'utf8'),
  );
}

async function commandDelivery(argv: string[], io: CliIO) {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'prepare') {
    await withCommandCtx(rest, io, async ({ repos: repositories, repoPath, runId }) => {
      const audit = createAuditLogger({ repositories });
      const preparation = await createPullRequestPreparation({
        repoPath,
        repositories,
        audit,
        runId,
      });
      io.stdout.write(
        [
          `runId=${runId}`,
          `branch=${preparation.branch}`,
          `baseBranch=${preparation.baseBranch}`,
          `packagePath=${preparation.packagePath}`,
          `prBodyPath=${preparation.prBodyPath}`,
          `requiresHumanApproval=${preparation.requiresHumanApproval}`,
        ].join(' ') + '\n',
      );
    });
    return;
  }

  if (subcommand === 'create-pr') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        'approve-human': { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(args.values.repo);
    await ensureInitialized(repoPath, io);
    await withProjectContext(repoPath, async ({ db, repos: repositories }) => {
      const runId =
        args.values['run-id'] ?? args.positionals[0] ?? selectLatestRunId(db);
      if (!runId) {
        throw new Error('run id could not be inferred; pass --run-id <runId>');
      }
      const audit = createAuditLogger({ repositories });
      const preparation = await createPullRequestPreparation({
        repoPath,
        repositories,
        audit,
        runId,
      });
      const body = readFileSync(preparation.prBodyPath, 'utf8');
      const result = await createScmDelivery({
        repoPath,
        repositories,
        audit,
        outputDir: join(repoPath, '.tekon', 'runs', runId, 'delivery', 'scm'),
      }).createPr({
        runId,
        title: preparation.title,
        body,
        bodyPath: preparation.prBodyPath,
        branch: preparation.branch,
        baseBranch: preparation.baseBranch,
        dryRun: false,
        humanApproved: Boolean(args.values['approve-human']),
        approvedBy: 'cli',
      });
      const delivery = await repositories.getDeliveryPullRequest(runId);
      io.stdout.write(
        [
          `runId=${runId}`,
          `deliveryStatus=${delivery?.status ?? 'unknown'}`,
          `requiresHumanApproval=${result.requiresHumanApproval}`,
          `prUrl=${result.prUrl ?? delivery?.prUrl ?? ''}`,
          `failureStage=${delivery?.failureStage ?? ''}`,
        ].join(' ') + '\n',
      );
    });
    return;
  }

  if (subcommand === 'ci-status') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        selector: { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(args.values.repo);
    await ensureInitialized(repoPath, io);
    const db = openProjectDb(repoPath);
    try {
      migrateDatabase(db);
      const runId =
        args.values['run-id'] ?? args.positionals[0] ?? selectLatestRunId(db);
      if (!runId) {
        throw new Error('run id could not be inferred; pass --run-id <runId>');
      }
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const report = await queryPullRequestCiStatus({
        repoPath,
        repositories,
        audit,
        runId,
        selector: args.values.selector,
      });
      io.stdout.write(
        [
          `runId=${runId}`,
          `ciStatus=${report.status}`,
          `checks=${report.checks.length}`,
          `artifactId=${report.artifact.id}`,
          `selector=${report.selector}`,
        ].join(' ') + '\n',
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand === 'ci-watch') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        selector: { type: 'string' },
        'max-attempts': { type: 'string' },
        'interval-ms': { type: 'string' },
        backoff: { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(args.values.repo);
    await ensureInitialized(repoPath, io);
    const db = openProjectDb(repoPath);
    try {
      migrateDatabase(db);
      const runId =
        args.values['run-id'] ?? args.positionals[0] ?? selectLatestRunId(db);
      if (!runId) {
        throw new Error('run id could not be inferred; pass --run-id <runId>');
      }
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const result = await watchPullRequestCiStatus({
        repoPath,
        repositories,
        audit,
        runId,
        selector: args.values.selector,
        maxAttempts: args.values['max-attempts']
          ? Number(args.values['max-attempts'])
          : undefined,
        intervalMs: args.values['interval-ms']
          ? Number(args.values['interval-ms'])
          : undefined,
        backoffMultiplier: args.values.backoff
          ? Number(args.values.backoff)
          : undefined,
      });
      io.stdout.write(
        [
          `runId=${runId}`,
          `ciStatus=${result.finalStatus}`,
          `terminal=${result.terminal}`,
          `attempts=${result.attempts}`,
          `maxAttempts=${result.maxAttempts}`,
          `checks=${result.finalReport.checks.length}`,
          `artifactId=${result.finalReport.artifact.id}`,
          `selector=${result.selector}`,
        ].join(' ') + '\n',
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand !== 'dry-run') {
    throw new Error(`unknown delivery command: ${subcommand ?? ''}`);
  }
  await withCommandCtx(rest, io, async ({ repos: repositories, repoPath, runId }) => {
    const audit = createAuditLogger({ repositories });
    const evidence = await createDeliveryEvidencePackage({
      repositories,
      audit,
      runId,
      riskGates: ['human'],
    });
    const pr = await createScmDelivery({ repoPath }).createPr({
      title: `Tekon delivery ${runId}`,
      body: `Run ${runId} status=${evidence.workflowStatus}`,
      branch: `tekon-delivery/${runId}`,
      dryRun: true,
    });
    io.stdout.write(
      [
        `runId=${runId}`,
        `workflowStatus=${evidence.workflowStatus}`,
        `artifacts=${evidence.artifacts.length}`,
        `prDryRun=${pr.dryRun}`,
        `requiresHumanApproval=${pr.requiresHumanApproval}`,
      ].join(' ') + '\n',
    );
  });
}

function createAgentAdapter(input: {
  agent: string;
  repoPath: string;
  gateway: CommandGateway;
  runtime?: ProviderRuntimeOverrides;
}): {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
} {
  if (input.agent === 'mock') {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: { provider: 'mock' },
    };
  }

  if (input.agent === 'claude-code') {
    const config = applyProviderRuntimeOverrides(
      defaultClaudeCodeConfig(input.repoPath),
      input.runtime,
    );
    return {
      adapter: createClaudeCodeAdapter(config, input.gateway),
      provider: 'claude-code',
      configSummary: summarizeAgentConfig(config),
    };
  }

  if (input.agent === 'codex') {
    const config = applyProviderRuntimeOverrides(
      defaultCodexConfig(input.repoPath),
      input.runtime,
    );
    return {
      adapter: createCodexAdapter(config, input.gateway),
      provider: 'codex',
      configSummary: summarizeAgentConfig(config),
    };
  }

  throw new Error(`unsupported agent: ${input.agent}`);
}

type ProviderRuntimeOverrides = Partial<
  Pick<
    AgentAdapterConfig,
    'timeoutMs' | 'progressHeartbeatMs' | 'noProgressTimeoutMs'
  >
>;

function providerRuntimeFromCliOptions(
  values: Record<string, string | boolean | undefined>,
): ProviderRuntimeOverrides {
  return {
    timeoutMs: parsePositiveIntOption(values['timeout-ms'], '--timeout-ms'),
    noProgressTimeoutMs: parsePositiveIntOption(
      values['no-progress-timeout-ms'],
      '--no-progress-timeout-ms',
    ),
    progressHeartbeatMs: parsePositiveIntOption(
      values['progress-heartbeat-ms'],
      '--progress-heartbeat-ms',
    ),
  };
}

function applyProviderRuntimeOverrides(
  config: AgentAdapterConfig,
  runtime?: ProviderRuntimeOverrides,
): AgentAdapterConfig {
  return {
    ...config,
    timeoutMs: runtime?.timeoutMs ?? config.timeoutMs,
    noProgressTimeoutMs:
      runtime?.noProgressTimeoutMs ?? config.noProgressTimeoutMs,
    progressHeartbeatMs:
      runtime?.progressHeartbeatMs ?? config.progressHeartbeatMs,
  };
}

function parsePositiveIntOption(
  value: string | boolean | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${name} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function createAgentAdapterFromSnapshot(input: {
  snapshot: RunProviderConfig;
  repoPath: string;
  gateway: CommandGateway;
}): {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
} {
  if (input.snapshot.provider === 'mock') {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: input.snapshot.configSummary,
    };
  }

  if (input.snapshot.provider === 'claude-code') {
    const parsed = agentAdapterConfigSchema.safeParse(
      input.snapshot.configSummary,
    );
    if (!parsed.success || parsed.data.provider !== 'claude-code') {
      throw new Error(
        `run ${input.snapshot.runId} has a non-replayable claude-code provider snapshot`,
      );
    }
    return {
      adapter: createClaudeCodeAdapter(parsed.data, input.gateway),
      provider: 'claude-code',
      configSummary: parsed.data,
    };
  }

  if (input.snapshot.provider === 'codex') {
    const parsed = agentAdapterConfigSchema.safeParse(
      input.snapshot.configSummary,
    );
    if (!parsed.success || parsed.data.provider !== 'codex') {
      throw new Error(
        `run ${input.snapshot.runId} has a non-replayable codex provider snapshot`,
      );
    }
    return {
      adapter: createCodexAdapter(parsed.data, input.gateway),
      provider: 'codex',
      configSummary: parsed.data,
    };
  }

  throw new Error('custom agent provider snapshots cannot be resumed safely');
}

function summarizeAgentConfig(
  config: AgentAdapterConfig,
): Record<string, unknown> {
  return {
    provider: config.provider,
    command: config.command,
    args: config.args,
    profile: config.profile,
    promptMode: config.promptMode,
    outputFormat: config.outputFormat,
    timeoutMs: config.timeoutMs,
    progressHeartbeatMs: config.progressHeartbeatMs,
    noProgressTimeoutMs: config.noProgressTimeoutMs,
    permissionProfile: {
      sandbox: config.permissionProfile.sandbox,
      approval: config.permissionProfile.approval,
      filesystemScope: config.permissionProfile.filesystemScope,
      network: config.permissionProfile.network,
      tools: config.permissionProfile.tools,
    },
  };
}

function defaultClaudeCodeConfig(repoPath: string): AgentAdapterConfig {
  return {
    provider: 'claude-code',
    command: 'claude',
    args: ['-p'],
    promptMode: 'stdin',
    outputFormat: 'json',
    timeoutMs: DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
    progressHeartbeatMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
    noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    permissionProfile: {
      sandbox: 'workspace-write',
      approval: 'on-failure',
      filesystemScope: [repoPath],
      network: 'restricted',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
}

function defaultCodexConfig(repoPath: string): AgentAdapterConfig {
  return {
    provider: 'codex',
    command: 'codex',
    args: [],
    profile: 'internal',
    promptMode: 'stdin',
    outputFormat: 'text',
    timeoutMs: DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
    progressHeartbeatMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
    noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    permissionProfile: {
      sandbox: 'workspace-write',
      approval: 'on-failure',
      filesystemScope: [repoPath],
      network: 'restricted',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
}

async function commandStatus(argv: string[], io: CliIO) {
  await withCommandCtx(argv, io, async ({ repos: repositories, repoPath, runId }) => {
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }
    const gates = await repositories.listGateResults(runId);
    const artifacts = await repositories.listArtifacts(runId);
    const pendingHuman = (await repositories.listHumanDecisions(runId)).filter(
      (decision) => decision.status === 'pending',
    );
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
  });
}

async function commandApproval(argv: string[], io: CliIO) {
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
      throw new Error('--max-chars must be a positive number');
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
          'pending human decision could not be inferred; pass --run-id and --decision-id',
        );
      }
      const audit = createAuditLogger({ repositories });
      const decision = await repositories.getHumanDecision(decisionId);
      if (!decision || decision.runId !== runId) {
        throw new Error(`human decision not found: ${decisionId}`);
      }
      if (decision.status !== 'pending') {
        throw new Error(
          `decision is already ${decision.status}: ${decisionId}`,
        );
      }
      const rejected = await createHumanGate({ repositories }).rejectHumanGate(
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

  throw new Error(`unknown approval command: ${subcommand ?? ''}`);
}

async function commandEval(argv: string[], io: CliIO) {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'demand-shape' || subcommand === 'draft-shape') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        shape: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const shapeArg = args.values.shape ?? args.positionals[0];
    const repoPath = resolveProjectRepoPath(args.values.repo);
    if (!shapeArg) {
      await ensureInitialized(repoPath, io);
    }
    const shape = readDemandShapeFile(
      resolveDemandShapePath(repoPath, shapeArg),
    );
    const evaluation = evaluateDemandShape(shape);
    io.stdout.write(
      args.values.json
        ? `${JSON.stringify(evaluation, null, 2)}\n`
        : [
            `draftId=${shape.id}`,
            `ready=${evaluation.ready}`,
            `score=${evaluation.score.toFixed(2)}`,
            `failed=${evaluation.checks
              .filter((check) => !check.passed)
              .map((check) => check.id)
              .join(',')}`,
          ].join(' ') + '\n',
    );
    return;
  }

  if (subcommand === 'workflow-selection') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        shape: { type: 'string' },
        template: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(args.values.repo);
    const positionalDemandText = args.positionals.join(' ').trim();
    const shapePath = args.values.shape
      ? resolveDemandShapePath(repoPath, args.values.shape)
      : positionalDemandText
        ? null
        : resolveDemandShapePath(repoPath);
    const shape = shapePath ? readDemandShapeFile(shapePath) : null;
    const demandText = shape ? shape.rawText : positionalDemandText;
    const evaluation = evaluateWorkflowSelection({
      text: demandText,
      selectedTemplate: args.values.template ?? shape?.recommendedTemplate,
      ...(shape ? { category: shape.category } : {}),
    });
    io.stdout.write(
      args.values.json
        ? `${JSON.stringify(evaluation, null, 2)}\n`
        : [
            `recommendedTemplate=${evaluation.recommendedTemplate}`,
            `selectedTemplate=${evaluation.selectedTemplate}`,
            `ready=${evaluation.ready}`,
            `score=${evaluation.score.toFixed(2)}`,
            `failed=${evaluation.checks
              .filter((check) => !check.passed)
              .map((check) => check.id)
              .join(',')}`,
          ].join(' ') + '\n',
    );
    return;
  }

  if (subcommand === 'approval-summary') {
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
      throw new Error('--max-chars must be a positive number');
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
          ? `${JSON.stringify(evaluation, null, 2)}\n`
          : [
              `runId=${runId}`,
              `decisionId=${summary.decisionId}`,
              `ready=${evaluation.ready}`,
              `score=${evaluation.score.toFixed(2)}`,
              `failed=${evaluation.checks
                .filter((check) => !check.passed)
                .map((check) => check.id)
                .join(',')}`,
            ].join(' ') + '\n',
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand === 'work-usability') {
    if (rest[0] === 'record') {
      await commandWorkUsabilityRecord(rest.slice(1), io);
      return;
    }
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        samples: { type: 'string' },
        json: { type: 'boolean', default: false },
        'report-md': { type: 'string' },
        'report-html': { type: 'string' },
        title: { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(args.values.repo);
    await ensureInitialized(repoPath, io);
    const samplePath = resolve(
      repoPath,
      args.values.samples ??
        join('.tekon', 'eval', 'work-usability-samples.yaml'),
    );
    if (!existsSync(samplePath)) {
      throw new Error(`work usability sample file not found: ${samplePath}`);
    }
    const sampleSet = workUsabilitySampleSetSchema.parse(
      parseYaml(readFileSync(samplePath, 'utf8')),
    );
    const db = openProjectDb(repoPath);
    migrateDatabase(db);
    try {
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const evaluation = await evaluateWorkUsability({
        repoPath,
        repositories,
        audit,
        sampleSet,
      });
      const reportMarkdownPath = args.values['report-md']
        ? resolve(repoPath, args.values['report-md'])
        : null;
      const reportHtmlPath = args.values['report-html']
        ? resolve(repoPath, args.values['report-html'])
        : null;
      if (reportMarkdownPath || reportHtmlPath) {
        const report = renderWorkUsabilityEvaluationReport({
          title: args.values.title ?? 'Tekon Work Usability Evaluation',
          generatedAt: new Date().toISOString(),
          samplePath,
          evaluation,
        });
        if (reportMarkdownPath) {
          mkdirSync(dirname(reportMarkdownPath), { recursive: true });
          writeFileSync(reportMarkdownPath, report.markdown, 'utf8');
        }
        if (reportHtmlPath) {
          mkdirSync(dirname(reportHtmlPath), { recursive: true });
          writeFileSync(reportHtmlPath, report.html, 'utf8');
        }
      }
      io.stdout.write(
        args.values.json
          ? `${JSON.stringify(evaluation, null, 2)}\n`
          : formatWorkUsabilityEvaluation(evaluation, {
              reportMarkdownPath,
              reportHtmlPath,
            }),
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand !== 'readiness') {
    throw new Error(`unknown eval command: ${subcommand ?? ''}`);
  }
  await withCommandCtx(rest, io, async ({ repos: repositories, repoPath, runId }) => {
    const audit = createAuditLogger({ repositories });
    const evaluation = await evaluateWorkReadiness({
      repositories,
      audit,
      runId,
      repoPath,
    });
    const deliveryPr = await repositories.getDeliveryPullRequest(runId);
    io.stdout.write(
      [
        `runId=${runId}`,
        `ready=${evaluation.ready}`,
        `score=${evaluation.score.toFixed(2)}`,
        `prCreated=${deliveryPr?.status === 'created' && Boolean(deliveryPr.prUrl)}`,
        `prUrl=${deliveryPr?.prUrl ?? ''}`,
        `failed=${evaluation.checks
          .filter((check) => !check.passed)
          .map((check) => check.id)
          .join(',')}`,
      ].join(' ') + '\n',
    );
  });
}

async function commandWorkUsabilityRecord(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      samples: { type: 'string' },
      'run-id': { type: 'string' },
      id: { type: 'string' },
      'draft-type': { type: 'string' },
      'demand-type': { type: 'string' },
      'expected-provider': { type: 'string' },
      'expected-pr-url': { type: 'string' },
      'require-real-provider': { type: 'boolean', default: false },
      'require-pr': { type: 'boolean', default: false },
      notes: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  const samplePath = resolve(
    repoPath,
    args.values.samples ??
      join('.tekon', 'eval', 'work-usability-samples.yaml'),
  );
  const sampleSet: WorkUsabilitySampleSet = existsSync(samplePath)
    ? workUsabilitySampleSetSchema.parse(
        parseYaml(readFileSync(samplePath, 'utf8')),
      )
    : { thresholds: {}, samples: [] };
  const db = openProjectDb(repoPath);
  migrateDatabase(db);
  try {
    const repositories = createRepositories(db);
    const runId =
      args.values['run-id'] ?? args.positionals[0] ?? selectLatestRunId(db);
    if (!runId) {
      throw new Error('run id could not be inferred; pass --run-id <runId>');
    }
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }
    const [providerConfig, deliveryPr] = await Promise.all([
      repositories.getRunProviderConfig(runId),
      repositories.getDeliveryPullRequest(runId),
    ]);
    const provider =
      args.values['expected-provider'] ?? providerConfig?.provider;
    const expectedPrUrl =
      args.values['expected-pr-url'] ?? deliveryPr?.prUrl ?? undefined;
    const requireRealProvider =
      args.values['require-real-provider'] ||
      Boolean(provider && provider !== 'mock');
    const requirePr = args.values['require-pr'] || Boolean(expectedPrUrl);
    const sample: WorkUsabilitySample = {
      id: args.values.id ?? runId,
      runId,
      ...((args.values['draft-type'] ?? args.values['demand-type'])
        ? {
            demandType: (args.values['draft-type'] ??
              args.values['demand-type']) as WorkUsabilitySample['demandType'],
          }
        : {}),
      ...(provider
        ? {
            expectedProvider:
              provider as WorkUsabilitySample['expectedProvider'],
          }
        : {}),
      requireRealProvider,
      requirePr,
      ...(expectedPrUrl ? { expectedPrUrl } : {}),
      ...(args.values.notes ? { notes: args.values.notes } : {}),
    };
    const result = upsertWorkUsabilitySample(sampleSet, sample);
    mkdirSync(dirname(samplePath), { recursive: true });
    writeFileSync(samplePath, stringifyYaml(result.sampleSet), 'utf8');
    io.stdout.write(
      [
        `sampleRecorded=true`,
        `created=${result.created}`,
        `samplePath=${samplePath}`,
        `id=${sample.id}`,
        `runId=${runId}`,
        `expectedProvider=${sample.expectedProvider ?? ''}`,
        `requireRealProvider=${sample.requireRealProvider}`,
        `requirePr=${sample.requirePr}`,
        `expectedPrUrl=${sample.expectedPrUrl ?? ''}`,
      ].join(' ') + '\n',
    );
  } finally {
    db.close();
  }
}

function formatWorkUsabilityEvaluation(
  evaluation: Awaited<ReturnType<typeof evaluateWorkUsability>>,
  reports: {
    reportMarkdownPath?: string | null;
    reportHtmlPath?: string | null;
  } = {},
): string {
  const failedThresholds = evaluation.thresholdChecks.filter(
    (check) => !check.passed,
  );
  const failedSampleChecks = evaluation.samples.flatMap((sample) =>
    sample.checks
      .filter((check) => !check.passed)
      .map((check) => `${sample.id}:${check.id}`),
  );
  return (
    [
      `usable=${evaluation.usable}`,
      `score=${evaluation.score.toFixed(2)}`,
      `samples=${evaluation.counts.samples}`,
      `readyRuns=${evaluation.counts.readyRuns}`,
      `realProviderRuns=${evaluation.counts.realProviderRuns}`,
      `createdPrs=${evaluation.counts.createdPrs}`,
      `securityScanPassed=${evaluation.counts.securityScanPassed}`,
      `isolationPassed=${evaluation.counts.isolationPassed}`,
      `failedThresholds=${failedThresholds.map((check) => check.id).join(',')}`,
      `failedSamples=${failedSampleChecks.join(',')}`,
      reports.reportMarkdownPath
        ? `reportMd=${reports.reportMarkdownPath}`
        : '',
      reports.reportHtmlPath ? `reportHtml=${reports.reportHtmlPath}` : '',
      '',
      '## Threshold Checks',
      ...evaluation.thresholdChecks.map(
        (check) => `- ${check.id}: ${check.passed} ${check.evidence}`,
      ),
      '',
      '## Samples',
      ...evaluation.samples.map((sample) =>
        [
          `- ${sample.id}: runId=${sample.runId} readiness=${sample.readiness?.ready ?? false} provider=${sample.provider ?? 'missing'} prCreated=${sample.prCreated} isolation=${sample.isolationPassed}`,
          ...sample.checks
            .filter((check) => !check.passed)
            .map((check) => `  - failed ${check.id}: ${check.evidence}`),
        ].join('\n'),
      ),
      '',
    ].join('\n') + '\n'
  );
}

async function commandReview(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
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
    throw new Error('--max-chars must be a positive number');
  }
  await withProjectContext(repoPath, async ({ db, repos: repositories }) => {
    const runId =
      args.values['run-id'] ?? args.positionals[0] ?? selectLatestRunId(db);
    if (!runId) {
      throw new Error('run id could not be inferred; pass --run-id <runId>');
    }
    const audit = createAuditLogger({ repositories });
    const surface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId,
      maxContentChars,
      commandDisplay:
        (args.values.repo ?? args.values['run-id'] ?? args.positionals[0])
          ? 'explicit'
          : 'default',
    });

    if (args.values.json) {
      io.stdout.write(`${JSON.stringify(surface, null, 2)}\n`);
      return;
    }

    io.stdout.write(formatReviewSurface(surface));
  });
}

function formatReviewSurface(
  surface: Awaited<ReturnType<typeof createWorkReviewSurface>>,
): string {
  const failedChecks = surface.readiness.checks.filter(
    (check) => !check.passed,
  );
  const lines = [
    `runId=${surface.runId}`,
    `workflowStatus=${surface.workflowStatus}`,
    `ready=${surface.readiness.ready}`,
    `score=${surface.readiness.score.toFixed(2)}`,
    `deliveryStatus=${surface.delivery.status}`,
    `prUrl=${surface.delivery.prUrl ?? ''}`,
    '',
    '## Readiness Failed Checks',
    ...(failedChecks.length === 0
      ? ['- none']
      : failedChecks.map(
          (check) => `- ${check.id} (${check.severity}): ${check.evidence}`,
        )),
    '',
    '## Evidence Navigation',
    ...(surface.evidenceGroups.length === 0
      ? ['- none']
      : surface.evidenceGroups.map((group) =>
          [
            `### ${group.title} ${group.status}`,
            `summary=${group.summary}`,
            ...group.links.map(
              (link) =>
                `- ${link.kind} ${link.label} -> ${link.href} (${link.summary})`,
            ),
          ].join('\n'),
        )),
    '',
    '## Gate Failure Triage',
    ...(surface.gateFailureTriage.length === 0
      ? ['- none']
      : surface.gateFailureTriage.map((item) =>
          [
            `### ${item.gateType} ${item.gateId} ${item.status}`,
            `classification=${item.classification} retry=${item.retry} log=${item.logHref}`,
            `summary=${item.summary}`,
            `suggestedCommand=${item.suggestedCommand}`,
          ].join('\n'),
        )),
    '',
    '## Delivery',
    `- packagePath: ${surface.delivery.package?.path ?? 'missing'}`,
    `- prBodyPath: ${surface.delivery.prBody?.path ?? 'missing'}`,
    `- diffAvailable: ${surface.delivery.diff.available}`,
    `- diffBranch: ${surface.delivery.diff.branch}`,
    `- diffBase: ${surface.delivery.diff.baseBranch}`,
    ...(surface.delivery.diff.reason
      ? [`- diffReason: ${surface.delivery.diff.reason}`]
      : []),
    '',
    '## Changed Files',
    ...(surface.delivery.diff.changedFiles.length === 0
      ? ['- none']
      : surface.delivery.diff.changedFiles.map((file) => `- ${file}`)),
    '',
    '## Artifacts',
    ...(surface.artifacts.length === 0
      ? ['- none']
      : surface.artifacts.map((artifact) =>
          [
            `### ${artifact.type} ${artifact.id}`,
            `path=${artifact.path} summary=${artifact.summary ?? ''}`,
            formatPreview(artifact.content),
          ].join('\n'),
        )),
    '',
    '## Gate Logs',
    ...(surface.gates.length === 0
      ? ['- none']
      : surface.gates.map((gate) =>
          [
            `### ${gate.gateType} ${gate.id} ${gate.status}`,
            `node=${gate.nodeId} failure=${gate.failureClassification ?? ''}`,
            gate.output ? formatPreview(gate.output) : 'output=missing',
          ].join('\n'),
        )),
    '',
    '## PR Body',
    surface.delivery.prBody
      ? formatPreview(surface.delivery.prBody)
      : 'missing',
    '',
    '## PR Package',
    surface.delivery.package
      ? formatPreview(surface.delivery.package)
      : 'missing',
    '',
    '## Next Commands',
    ...surface.nextCommands.map((command) => `- ${command}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function formatApprovalSummary(
  summary: Awaited<ReturnType<typeof createHumanApprovalSummary>>,
  evaluation: ReturnType<typeof evaluateHumanApprovalSummary>,
): string {
  return [
    `decisionId=${summary.decisionId}`,
    `runId=${summary.runId}`,
    `ready=${evaluation.ready}`,
    `score=${evaluation.score.toFixed(2)}`,
    `risk=${summary.riskLabel}`,
    `exactCommand=${summary.exactCommand}`,
    `impact=${summary.impact.status}`,
    `failed=${evaluation.checks
      .filter((check) => !check.passed)
      .map((check) => check.id)
      .join(',')}`,
    '',
    summary.summaryText,
  ].join('\n');
}

function formatPreview(preview: {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}): string {
  if (!preview.exists) {
    return `path=${preview.path} exists=false`;
  }
  return [
    `path=${preview.path} sizeBytes=${preview.sizeBytes} truncated=${preview.truncated}`,
    '```',
    preview.content,
    '```',
  ].join('\n');
}

async function commandLog(argv: string[], io: CliIO) {
  await withCommandCtx(argv, io, async ({ repos: repositories, runId }) => {
    const events = await repositories.listAuditEvents(runId);
    for (const event of events) {
      io.stdout.write(
        `${event.createdAt} ${event.type} ${JSON.stringify(event.payload)}\n`,
      );
    }
  });
}

async function commandClean(argv: string[], io: CliIO) {
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

function resolveTekonRoot(): string {
  if (process.env.TEKON_HOME) {
    return resolve(process.env.TEKON_HOME);
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const defaultPath = join(home, '.tekon');
  if (existsSync(defaultPath)) {
    return defaultPath;
  }
  throw new Error(
    'Cannot find Tekon installation. Set TEKON_HOME env or run the install script.',
  );
}

async function commandUi(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      port: { type: 'string' },
    },
    allowPositionals: true,
  });
  const port = args.values.port ?? '3000';
  if (!/^\d+$/u.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(
      `Invalid port: ${port}. Must be a number between 1 and 65535.`,
    );
  }

  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);

  const tokenPath = join(repoPath, '.tekon', 'web-session.json');
  if (!existsSync(tokenPath)) {
    throw new Error('web-session.json not found; run "tekon init" first');
  }
  const { token } = JSON.parse(readFileSync(tokenPath, 'utf8')) as {
    token: string;
  };
  if (!token || typeof token !== 'string') {
    throw new Error(
      `Invalid web-session.json at ${tokenPath}; run "tekon init" first`,
    );
  }

  const tekonRoot = resolveTekonRoot();
  const webDir = join(tekonRoot, 'packages', 'web');
  if (!existsSync(webDir)) {
    throw new Error(`web package not found at ${webDir}`);
  }

  const tsxBin = join(webDir, 'node_modules', '.bin', 'tsx');
  if (!existsSync(tsxBin)) {
    io.stdout.write('Installing dependencies...\n');
    execFileSync(
      'npm',
      ['exec', '--yes', '--', 'pnpm@10.12.1', 'install', '--frozen-lockfile'],
      { cwd: tekonRoot, stdio: 'inherit' },
    );
    if (!existsSync(tsxBin)) {
      throw new Error(
        `tsx still not found at ${tsxBin} after install. Check pnpm install output above.`,
      );
    }
  }

  io.stdout.write(`repo=${repoPath}\n`);
  io.stdout.write(`url=http://localhost:${port}\n`);
  io.stdout.write('Starting Tekon Web... Press Ctrl+C to stop\n');

  const child = spawn(tsxBin, ['src/server/index.ts'], {
    cwd: webDir,
    env: {
      ...process.env,
      TEKON_PROJECT_ROOT: repoPath,
      PORT: port,
    },
    stdio: 'inherit',
    shell: false,
  });

  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0 || code === null) {
        resolve();
      } else {
        reject(new Error(`Web server exited with code ${code}`));
      }
    });
  });
}

function silentExec(cmd: string, args: string[], opts: { cwd: string }) {
  try {
    return execFileSync(cmd, args, {
      ...opts,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
    throw new Error(
      `${cmd} ${args.join(' ')} failed: ${stderr || (error instanceof Error ? error.message : String(error))}`,
    );
  }
}

async function commandUpdate(_argv: string[], io: CliIO) {
  const tekonRoot = resolveTekonRoot();
  if (!existsSync(tekonRoot)) {
    throw new Error(
      'Tekon not installed. Run: curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash',
    );
  }

  const currentPkg = JSON.parse(
    readFileSync(join(tekonRoot, 'package.json'), 'utf8'),
  ) as { version: string };
  const oldVersion = currentPkg.version;

  execFileSync('git', ['fetch', 'origin', 'main'], {
    cwd: tekonRoot,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  const remotePkgJson = execFileSync(
    'git',
    ['show', 'FETCH_HEAD:package.json'],
    { cwd: tekonRoot, encoding: 'utf8' },
  );
  const targetVersion = (
    JSON.parse(remotePkgJson) as { version: string }
  ).version;

  if (oldVersion === targetVersion) {
    io.stdout.write(`Already up to date (v${oldVersion})\n`);
    return;
  }

  io.stdout.write(`Updating v${oldVersion} → v${targetVersion}...\n`);

  silentExec('git', ['checkout', 'main'], { cwd: tekonRoot });
  silentExec('git', ['pull', 'origin', 'main'], { cwd: tekonRoot });
  silentExec('npm', ['exec', '--yes', '--', 'pnpm@10.12.1', 'install', '--frozen-lockfile'], { cwd: tekonRoot });
  silentExec('npm', ['exec', '--yes', '--', 'pnpm@10.12.1', 'build'], { cwd: tekonRoot });

  const cliPath = join(tekonRoot, 'packages', 'cli', 'dist', 'index.js');
  if (!existsSync(cliPath)) {
    throw new Error(`Build failed: ${cliPath} not found`);
  }

  io.stdout.write(`Updated to v${targetVersion}\n`);
}

function resolveRepoPathForInit(repoArg?: string): string {
  if (repoArg) {
    return resolve(repoArg);
  }
  return (
    findInitializedRepoRoot(process.cwd()) ??
    findGitRoot() ??
    resolve(process.cwd())
  );
}

function resolveProjectRepoPath(repoArg?: string): string {
  if (repoArg) {
    return resolve(repoArg);
  }
  return (
    findInitializedRepoRoot(process.cwd()) ??
    findGitRoot() ??
    resolve(process.cwd())
  );
}

function findInitializedRepoRoot(startDir: string): string | null {
  return findUp(startDir, (dir) =>
    existsSync(join(dir, '.tekon', 'config.yaml')),
  );
}

function findUp(
  startDir: string,
  predicate: (candidateDir: string) => boolean,
): string | null {
  let current = resolve(startDir);
  for (;;) {
    if (predicate(current)) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function findGitRoot(): string | null {
  try {
    return execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

function resolveDemandShapePath(
  repoPath: string,
  shapeArg?: string,
  options: {
    latestMustBeApproved?: boolean;
    latestMustBeUnapproved?: boolean;
  } = {},
): string {
  if (shapeArg) {
    const shapePath = resolveExplicitPath(repoPath, shapeArg);
    if (!existsSync(shapePath)) {
      throw new Error(`draft shape file not found: ${shapePath}`);
    }
    return shapePath;
  }

  const candidates = listDemandShapeCandidates(repoPath);
  if (candidates.length === 0) {
    throw new Error(
      `no draft shape files found in ${join(repoPath, '.tekon', 'drafts')}`,
    );
  }

  const latest = candidates[0];
  if (options.latestMustBeApproved && !latest.shape.approved) {
    throw new Error(
      `latest draft shape is not approved: ${latest.path}; run tekon draft approve or pass --draft-file <path>`,
    );
  }
  if (options.latestMustBeUnapproved && latest.shape.approved) {
    throw new Error(
      `latest draft shape is already approved: ${latest.path}; pass --shape <path> to approve a historical draft shape`,
    );
  }

  return latest.path;
}

function resolveExplicitPath(repoPath: string, inputPath: string): string {
  if (inputPath.startsWith('/')) {
    return inputPath;
  }
  const cwdPath = resolve(process.cwd(), inputPath);
  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  return resolve(repoPath, inputPath);
}

function listDemandShapeCandidates(repoPath: string): Array<{
  path: string;
  shape: DemandShape;
  mtimeMs: number;
}> {
  const candidates: Array<{
    path: string;
    shape: DemandShape;
    mtimeMs: number;
  }> = [];

  const dirs = [
    join(repoPath, '.tekon', 'drafts'),
    join(repoPath, '.tekon', 'demands'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir)) {
      if (!entry.endsWith('.json')) continue;
      const shapePath = join(dir, entry);
      try {
        candidates.push({
          path: shapePath,
          shape: readDemandShapeFile(shapePath),
          mtimeMs: statSync(shapePath).mtimeMs,
        });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return candidates.sort((left, right) => {
    const createdCompare = right.shape.createdAt.localeCompare(
      left.shape.createdAt,
    );
    if (createdCompare !== 0) {
      return createdCompare;
    }
    const mtimeCompare = right.mtimeMs - left.mtimeMs;
    if (mtimeCompare !== 0) {
      return mtimeCompare;
    }
    return right.path.localeCompare(left.path);
  });
}

function selectLatestRunId(db: TekonDatabase): string | null {
  const row = db
    .prepare(
      `select id
       from workflow_instances
       order by datetime(updated_at) desc, datetime(created_at) desc, id desc
       limit 1`,
    )
    .get() as { id: string } | undefined;
  return row?.id ?? null;
}

function selectLatestPendingHumanDecision(
  db: TekonDatabase,
): { runId: string; decisionId: string } | null {
  const row = db
    .prepare(
      `select run_id as runId, id as decisionId
       from human_decisions
       where status = 'pending'
       order by datetime(created_at) desc, id desc
       limit 1`,
    )
    .get() as { runId: string; decisionId: string } | undefined;
  return row ?? null;
}

function countPendingHumanDecisionsForRun(
  db: TekonDatabase,
  runId: string,
): number {
  const row = db
    .prepare(
      `select count(*) as count
       from human_decisions
       where run_id = ? and status = 'pending'`,
    )
    .get(runId) as { count: number } | undefined;
  return row?.count ?? 0;
}

function assertUnambiguousPendingDecisionForRun(
  db: TekonDatabase,
  runId: string,
): void {
  const pendingCount = countPendingHumanDecisionsForRun(db, runId);
  if (pendingCount > 1) {
    throw new Error(
      `multiple pending human decisions found for run ${runId}; pass --decision-id <decisionId>`,
    );
  }
}

async function resolveHumanDecisionContext(input: {
  db: TekonDatabase;
  repositories: TekonRepositories;
  explicitRunId?: string;
  explicitDecisionId?: string;
  requireDecision?: boolean;
}): Promise<{ runId: string; decisionId?: string }> {
  if (input.explicitDecisionId) {
    const decision = await input.repositories.getHumanDecision(
      input.explicitDecisionId,
    );
    if (!decision) {
      throw new Error(`human decision not found: ${input.explicitDecisionId}`);
    }
    if (input.explicitRunId && decision.runId !== input.explicitRunId) {
      throw new Error(
        `decision ${decision.id} belongs to run ${decision.runId}, not ${input.explicitRunId}`,
      );
    }
    return { runId: decision.runId, decisionId: decision.id };
  }

  if (input.explicitRunId) {
    assertUnambiguousPendingDecisionForRun(input.db, input.explicitRunId);
    const pendingDecision = (
      await input.repositories.listHumanDecisions(input.explicitRunId)
    )
      .filter((decision) => decision.status === 'pending')
      .at(-1);
    if (!pendingDecision && input.requireDecision) {
      throw new Error(
        `run has no pending human decision: ${input.explicitRunId}`,
      );
    }
    return {
      runId: input.explicitRunId,
      decisionId: pendingDecision?.id,
    };
  }

  const latestPendingDecision = selectLatestPendingHumanDecision(input.db);
  if (latestPendingDecision) {
    assertUnambiguousPendingDecisionForRun(
      input.db,
      latestPendingDecision.runId,
    );
    return {
      runId: latestPendingDecision.runId,
      decisionId: latestPendingDecision.decisionId,
    };
  }

  if (input.requireDecision) {
    throw new Error(
      'pending human decision could not be inferred; pass --run-id and --decision-id',
    );
  }

  const runId = selectLatestRunId(input.db);
  if (!runId) {
    throw new Error('run id could not be inferred; pass --run-id <runId>');
  }
  return { runId };
}

function openProjectDb(repoPath: string) {
  mkdirSync(join(repoPath, '.tekon'), { recursive: true });
  return openTekonDatabase({
    filename: join(repoPath, '.tekon', 'tekon.sqlite'),
  });
}

async function withProjectContext<T>(
  repoPath: string,
  fn: (ctx: { db: TekonDatabase; repos: TekonRepositories }) => T | Promise<T>,
): Promise<T> {
  const db = openProjectDb(repoPath);
  try {
    migrateDatabase(db);
    return await fn({ db, repos: createRepositories(db) });
  } finally {
    db.close();
  }
}

async function withCommandCtx<T>(
  argv: string[],
  io: CliIO,
  fn: (ctx: {
    db: TekonDatabase;
    repos: TekonRepositories;
    repoPath: string;
    runId: string;
  }) => T | Promise<T>,
): Promise<T> {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  return withProjectContext(repoPath, ({ db, repos }) => {
    const runId =
      args.values['run-id'] ?? args.positionals[0] ?? selectLatestRunId(db);
    if (!runId) {
      throw new Error('run id could not be inferred; pass --run-id <runId>');
    }
    return fn({ db, repos, repoPath, runId });
  });
}

function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    const { stdin } = process;
    if (!stdin.isTTY) {
      resolve('');
      return;
    }
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.once('data', (data) => {
      stdin.pause();
      resolve(String(data).trim());
    });
    stdin.once('close', () => {
      resolve('');
    });
  });
}

function initializeProject(repoPath: string, io: CliIO): void {
  const tekonDir = join(repoPath, '.tekon');
  mkdirSync(join(tekonDir, 'runs'), { recursive: true });
  mkdirSync(join(tekonDir, 'roles'), { recursive: true });
  mkdirSync(join(tekonDir, 'workflows'), { recursive: true });
  mkdirSync(join(tekonDir, 'worktrees'), { recursive: true });
  mkdirSync(join(tekonDir, 'eval'), { recursive: true });
  const webSessionPath = join(tekonDir, 'web-session.json');
  if (!existsSync(webSessionPath)) {
    writeFileSync(
      webSessionPath,
      JSON.stringify({ token: randomBytes(32).toString('hex') }, null, 2),
      { encoding: 'utf8', mode: 0o600 },
    );
  }
  writeFileSync(
    join(tekonDir, 'config.yaml'),
    stringifyYaml({
      project: { name: basenameForProject(repoPath), repoPath },
      storage: { dataDir: '.tekon' },
      defaultAgent: 'codex',
    }),
    'utf8',
  );
  const db = openProjectDb(repoPath);
  try {
    migrateDatabase(db);
  } finally {
    db.close();
  }
  const profilePath = join(tekonDir, 'repo-profile.yaml');
  if (!existsSync(profilePath)) {
    writeDefaultRepoProfile(repoPath);
  }
  io.stdout.write(
    [
      '项目初始化完成',
      `仓库路径: ${repoPath}`,
      '',
      '后续操作:',
      '  tekon draft new <需求描述>  创建需求草稿',
      '  tekon role list               查看可用角色',
      '  tekon workflow list           查看可用工作流',
      '',
    ].join('\n'),
  );
}

function readConfigDefaultAgent(repoPath: string): string | undefined {
  try {
    const configPath = join(repoPath, '.tekon', 'config.yaml');
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, 'utf8');
    const config = parseYaml(raw) as { defaultAgent?: string } | null;
    return config?.defaultAgent ?? undefined;
  } catch {
    return undefined;
  }
}

function resolveAgentCommand(repoPath: string): string | undefined {
  const agent = readConfigDefaultAgent(repoPath) ?? 'codex';
  // Currently only claude-code supports interactive AI clarification
  // (codex uses different CLI flags not compatible with draft-agent.ts)
  switch (agent) {
    case 'claude-code':
      return 'claude';
    default:
      return undefined;
  }
}

async function ensureInitialized(repoPath: string, io: CliIO): Promise<void> {
  if (existsSync(join(repoPath, '.tekon', 'config.yaml'))) {
    return;
  }

  io.stdout.write(`Project not initialized: ${repoPath}\n`);
  io.stdout.write('Initialize now? [Y/n] ');

  const answer = await readStdinLine();
  if (!answer || answer.toLowerCase().startsWith('y')) {
    io.stdout.write('\n');
    initializeProject(repoPath, io);
    return;
  }

  io.stdout.write('\n');
  throw new Error(
    `not initialized: ${repoPath}. Run "tekon init" to initialize the project.`,
  );
}

function assertCleanBase(repoPath: string, allowDirtyBase: boolean): void {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  const meaningfulDirtyLines = status
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith('?? .tekon/'));

  if (meaningfulDirtyLines.length > 0 && !allowDirtyBase) {
    throw new Error(
      'dirty base worktree requires --allow-dirty-base before tekon run',
    );
  }
}

function basenameForProject(repoPath: string) {
  return repoPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'tekon';
}

function getRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function getBuiltInRolesDir() {
  return join(getRepoRoot(), 'roles');
}

function getBuiltInWorkflowsDir() {
  return join(getRepoRoot(), 'workflows');
}

function listWorkflowNames(workflowsDir: string) {
  if (!existsSync(workflowsDir)) {
    return [];
  }
  return readdirSync(workflowsDir)
    .filter((entry) => entry.endsWith('.yaml'))
    .map((entry) => entry.slice(0, -'.yaml'.length));
}

function loadWorkflowByName(name: string, projectWorkflowsDir: string) {
  ensureSafeName(name);
  const workflowsDir = existsSync(join(projectWorkflowsDir, `${name}.yaml`))
    ? projectWorkflowsDir
    : getBuiltInWorkflowsDir();
  return loadWorkflowTemplate({ name, workflowsDir });
}

function getWorkflowFilePath(name: string, projectWorkflowsDir: string) {
  ensureSafeName(name);
  const projectPath = join(projectWorkflowsDir, `${name}.yaml`);
  if (existsSync(projectPath)) {
    return projectPath;
  }
  return join(getBuiltInWorkflowsDir(), `${name}.yaml`);
}

function ensureSafeName(name: string) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(name)) {
    throw new Error(`invalid name: ${name}`);
  }
}
