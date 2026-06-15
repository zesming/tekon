#!/usr/bin/env node

import { commandApproval, commandCancel, commandPause, commandResume } from './commands/approval.js';
import { commandDelivery } from './commands/delivery.js';
import { commandDemand } from './commands/draft.js';
import { commandEval } from './commands/eval.js';
import { commandHelp } from './commands/help.js';
import { commandInit } from './commands/init.js';
import { commandReview } from './commands/review.js';
import { commandRole } from './commands/role.js';
import { commandRun } from './commands/run.js';
import { commandClean, commandLog, commandStatus } from './commands/status.js';
import { commandUi, commandUpdate } from './commands/ui.js';
import { commandConstraints, commandWorkflow } from './commands/workflow.js';
import { getVersion } from './lib/utils.js';

export type { CliIO } from './lib/context.js';
import type { CliIO } from './lib/context.js';

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
  { name: 'constraints', description: '查看 Tekon 约束配置', group: '工作流与角色', subcommands: [
    { name: 'show', description: '显示约束配置内容' },
  ] },
  // 交付
  { name: 'delivery', description: '准备和创建交付 PR', group: '交付', subcommands: [
    { name: 'prepare', description: '准备交付 PR' },
    { name: 'create-pr', description: '创建 PR' },
    { name: 'dry-run', description: '预览交付计划，不产生远端副作用' },
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
      return await commandHelp([], io, COMMANDS);
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
        return await commandHelp(rest, io, COMMANDS);
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
