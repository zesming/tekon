import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  buildClaudeProviderEnv,
  buildCodexProviderEnv,
  loadRepoProfile,
  probeProvider,
  readTekonConfig,
  resolveDefaultAgent,
  type ProbedProvider,
  type ProviderProbe,
  type TekonRepoConfig,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';
import { resolveProjectRepoPath } from '../lib/path-utils.js';
import { formatAuthKind } from '../lib/run-outcome.js';
import { loadWorkflowByName } from '../lib/utils.js';
import { gateCommandStatus } from './workflow.js';

const PROVIDERS: ProbedProvider[] = ['claude-code', 'codex'];

const INSTALL_HINT: Record<ProbedProvider, string> = {
  'claude-code': '安装 Claude Code（claude 命令），并确认启动 Tekon 的终端里能执行它',
  codex: '安装 Codex CLI（codex 命令），并确认启动 Tekon 的终端里能执行它',
};

const LOGIN_HINT: Record<ProbedProvider, string> = {
  'claude-code': '执行 claude /login，或在启动 Tekon 的环境里配置 ANTHROPIC_API_KEY',
  codex: '执行 codex login，或在启动 Tekon 的环境里配置 OPENAI_API_KEY',
};

/**
 * Checks what a run needs before it starts: repository config, each provider
 * (installed, how it would authenticate) and the commands the default
 * workflow's gates call. Reports and suggests only; changes nothing.
 */
export async function commandDoctor(argv: string[], io: CliIO): Promise<number> {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      workflow: { type: 'string' },
    },
    allowPositionals: false,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  const problems: string[] = [];
  const lines = ['Tekon doctor', `仓库: ${repoPath}`, ''];

  const initialized = existsSync(join(repoPath, '.tekon', 'config.yaml'));
  let config: TekonRepoConfig = {};
  if (!initialized) {
    lines.push('配置: 未初始化');
    problems.push('运行 tekon init 初始化项目');
  } else {
    try {
      config = readTekonConfig(repoPath);
      lines.push(
        `配置: .tekon/config.yaml，默认 agent ${resolveDefaultAgent(config)}${config.defaultAgent ? '' : '（未设置，使用内置默认）'}`,
      );
    } catch (error) {
      lines.push(`配置: ${(error as Error).message}`);
      problems.push('修正 .tekon/config.yaml');
    }
  }
  const defaultAgent = resolveDefaultAgent(config);

  lines.push('', 'Provider:');
  for (const provider of PROVIDERS) {
    const passthroughEnv = config.providers?.[provider]?.passthroughEnv ?? [];
    const env = provider === 'claude-code'
      ? buildClaudeProviderEnv(process.env, passthroughEnv)
      : buildCodexProviderEnv(process.env, passthroughEnv);
    const probe = await probeProvider(provider, { env, includeVersion: true });
    const isDefault = provider === defaultAgent;
    lines.push(`  ${describeProbe(probe)}${isDefault ? '（默认）' : ''}`);
    if (passthroughEnv.length > 0) {
      lines.push(`    透传环境变量: ${passthroughEnv.join(', ')}`);
    }
    if (!probe.installed) {
      lines.push(`    下一步: ${INSTALL_HINT[provider]}`);
      if (isDefault) {
        problems.push(
          `默认 agent ${provider} 未安装：${INSTALL_HINT[provider]}；或修改 .tekon/config.yaml 的 defaultAgent，或运行时加 --agent`,
        );
      }
    } else if (probe.auth === 'none') {
      lines.push(`    下一步: ${LOGIN_HINT[provider]}`);
      if (isDefault) problems.push(`默认 agent ${provider} 未登录：${LOGIN_HINT[provider]}`);
    }
  }

  if (initialized) {
    const workflowName = args.values.workflow ?? 'standard-delivery';
    lines.push('', `工作流检查（${workflowName}）:`);
    try {
      const template = loadWorkflowByName(
        workflowName,
        join(repoPath, '.tekon', 'workflows'),
      );
      const profile = loadRepoProfile(repoPath);
      const missing: string[] = [];
      for (const phase of template.phases) {
        for (const node of phase.nodes) {
          for (const gate of node.gates) {
            if (gateCommandStatus(repoPath, profile, gate).status === 'missing') {
              missing.push(`${node.id}/${gate.type}`);
            }
          }
        }
      }
      if (missing.length === 0) {
        lines.push('  门禁命令都已解析');
      } else {
        lines.push(`  缺少命令: ${missing.join(', ')}`);
        lines.push(`  下一步: tekon workflow preflight ${workflowName} 查看修复方法`);
        problems.push(`工作流 ${workflowName} 有 ${missing.length} 个门禁缺少命令`);
      }
    } catch (error) {
      lines.push(`  无法读取: ${(error as Error).message}`);
      problems.push(`检查工作流 ${workflowName}`);
    }
  }

  lines.push('');
  if (problems.length === 0) {
    lines.push('结论: 可以开始运行');
  } else {
    lines.push('结论: 运行前需要处理');
    for (const problem of problems) lines.push(`  - ${problem}`);
  }
  io.stdout.write(`${lines.join('\n')}\n`);
  return problems.length === 0 ? 0 : 1;
}

function describeProbe(probe: ProviderProbe): string {
  if (!probe.installed) return `${probe.provider}: 未安装（PATH 里没有 ${probe.command}）`;
  return `${probe.provider}: 已安装${probe.version ? ` ${probe.version}` : ''}，认证方式: ${formatAuthKind(probe.auth)}`;
}
