import {
  inspectCurrentBinding,
  validateRunPlanV3,
  type BindingDiff,
  type RunPlanV3,
  type RunProviderConfig,
  type WorkflowInstance,
} from '@tekon/core';

/**
 * PD-05：解析运行冻结的 v3 计划。v2/更早快照或损坏数据返回 null——只读差异
 * 提示是增强能力，不能阻断 resume/status 主流程。
 */
export function loadFrozenV3Plan(workflow: WorkflowInstance): RunPlanV3 | null {
  if (!workflow.planSnapshot) return null;
  try {
    const parsed: unknown = JSON.parse(workflow.planSnapshot);
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { digestVersion?: unknown }).digestVersion !== 3
    ) {
      return null;
    }
    return validateRunPlanV3(parsed);
  } catch {
    return null;
  }
}

/**
 * 只读比较当前仓库配置与运行冻结绑定；无 v3 快照或当前配置不可读（损坏的
 * repo-profile/package.json）时返回 null——差异提示是增强能力，绝不能让
 * status/resume 主流程因探测失败而中断，也不能泄露配置原文。
 */
export function inspectRunBinding(input: {
  repoPath: string;
  workflow: WorkflowInstance;
  frozenProvider: RunProviderConfig;
}): BindingDiff | null {
  const frozenPlan = loadFrozenV3Plan(input.workflow);
  if (!frozenPlan) return null;
  try {
    return inspectCurrentBinding({
      repoPath: input.repoPath,
      frozenPlan,
      frozenProvider: input.frozenProvider,
    });
  } catch {
    return null;
  }
}

/** 把分项差异渲染成 CLI 提示行（带两空格缩进，随原因/下一步块输出）。 */
export function formatBindingDiff(diff: BindingDiff): string[] {
  const lines: string[] = [];
  if (diff.agent) {
    lines.push(`  agent: ${diff.agent.from} → ${diff.agent.to}`);
  }
  if (diff.provider) {
    const label = diff.provider.configChanged ? '配置变化' : '提供者切换';
    lines.push(
      `  provider: ${diff.provider.fromProvider} → ${diff.provider.toProvider}（${label}）`,
    );
  }
  for (const change of diff.repoCommands) {
    const detail =
      change.current.status === 'resolved' &&
      change.frozen.status !== 'resolved'
        ? `（新命令: ${change.current.command.tool} ${change.current.command.args.join(' ')}）`
        : '';
    lines.push(
      `  commands.${change.commandRef}: ${change.frozen.status} → ${change.current.status}${detail}`,
    );
  }
  return lines;
}
