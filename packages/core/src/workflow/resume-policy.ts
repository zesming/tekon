import { gateTypeSchema } from '../types/domain.js';
import { evaluateCommandPolicy } from '../runtime/command-gateway.js';
import {
  loadRepoProfile,
  repoProfileCommandResolution,
} from '../repo/profile.js';
import { mergeRoleAndGatePolicy } from '../role/policy-merge.js';
import type { CommandPolicy } from '../types/config.js';
import { gateCommandPolicy } from './workflow-runtime.js';
import type { WorkflowGateConfig } from './template.js';

/**
 * PD-31：resume 时确定性失败的 fail-fast 白名单。未列入的分类一律保留
 * agent 重跑（可能修复），只有这三类在绑定/策略/模板不变的前提下重跑
 * 结果不会改变，盲目重跑只会白烧一个节点级 agent 调用。
 */
export const FAIL_FAST_CLASSIFICATIONS = [
  'missing-command',
  'rejected',
  'unsupported-gate',
] as const;

export interface DeterministicBlock {
  classification: (typeof FAIL_FAST_CLASSIFICATIONS)[number];
  reason: string;
  hint: string;
}

/**
 * 与 gate-runner.resolveGateCommand 同一规则的恢复侧解析：只对仍带
 * commandRef 的门禁重读当前 repo-profile；v3 物化后的门禁已删
 * commandRef，原样返回（其冻结身份不能被运行期重读覆盖）。
 */
export function resolveGateCommandForResume(
  profileRepoPath: string,
  gate: WorkflowGateConfig,
): WorkflowGateConfig {
  if (!gate.commandRef || gate.command) return gate;
  const profile = loadRepoProfile(profileRepoPath);
  const resolution = repoProfileCommandResolution(profile, gate.commandRef);
  if (resolution.status === 'resolved') {
    return { ...gate, command: resolution.command };
  }
  if (resolution.status === 'not-applicable') {
    if (gate.type === 'security-scan') return gate;
    return {
      ...gate,
      skipReason: `repo profile commands.${gate.commandRef} is not applicable: ${resolution.reason}`,
    };
  }
  return gate;
}

/**
 * 判定 blocked 节点是否应 fail-fast。分类不在白名单、或造成失败的条件
 * 当前已不成立时返回 null（调用方走常规重跑）；条件仍成立时返回可直接
 * 展示给用户的原因与下一步。纯函数，不接触数据库，便于单测覆盖。
 *
 * 路径语义与 gate-runner 对齐：repo-profile 从主仓库读
 * （profileRepoPath），命令策略按门禁实际 cwd 评估（policyCwd，通常是
 * 租约工作树路径，合成租约时等于主仓库路径）。
 */
export function evaluateDeterministicBlock(input: {
  profileRepoPath: string;
  policyCwd: string;
  gate: WorkflowGateConfig;
  classification: string | null | undefined;
  /**
   * 10a-2：拥有该 gate 的节点角色命令策略，由 node-executor 编译后传入，
   * 保持本函数纯函数、不引入 loadRole 磁盘 IO。与运行期 gate-runner 同一
   * 合并语义，避免 resume 裁决与运行期分叉。
   */
  rolePolicy: CommandPolicy;
}): DeterministicBlock | null {
  const { classification } = input;
  if (
    !classification ||
    !(FAIL_FAST_CLASSIFICATIONS as readonly string[]).includes(classification)
  ) {
    return null;
  }

  if (classification === 'unsupported-gate') {
    if (gateTypeSchema.safeParse(input.gate.type).success) {
      return null;
    }
    return {
      classification,
      reason: `门禁类型 ${input.gate.type} 不受支持（unsupported-gate），重跑 agent 不会改变结果。`,
      hint: '修正工作流模板中的门禁类型后重新发起运行。',
    };
  }

  const gate = resolveGateCommandForResume(input.profileRepoPath, input.gate);

  if (classification === 'missing-command') {
    if (gate.skipReason) return null;
    if (gate.command) return null;
    if (!gate.commandRef) {
      // v3 受理时门禁已物化并删除 commandRef：当前 profile 的变化触达不到
      // 冻结绑定，继续指引“补全 profile”是死路，只能显式 --rebind 或新运行。
      return {
        classification,
        reason:
          '门禁命令在受理时已冻结进执行计划且当时缺失（missing-command），修改 repo-profile 不会改变本运行的冻结绑定，重跑 agent 必然再次失败。',
        hint: '使用 tekon resume --rebind 采用当前仓库配置后恢复，或重新发起运行。',
      };
    }
    return {
      classification,
      reason:
        '门禁绑定的检查命令仍缺失（missing-command），在配置修复前重跑 agent 必然再次失败。',
      hint: gate.commandRef
        ? `在 .tekon/repo-profile.yaml 的 commands.${gate.commandRef} 下补全工具命令，或标记为 notApplicable，然后恢复运行；要让本运行直接采用新配置，使用 tekon resume --rebind。`
        : '在工作流模板或 repo-profile 中为该门禁补全命令，然后恢复运行。',
    };
  }

  // classification === 'rejected'
  if (!gate.command) {
    // 命令已不存在：下一次门禁会按 missing-command 分类，不再是 rejected。
    return null;
  }
  const rejection = evaluateCommandPolicy(
    gate.command,
    mergeRoleAndGatePolicy(
      input.rolePolicy,
      gateCommandPolicy(input.policyCwd, gate),
      input.policyCwd,
    ),
    input.policyCwd,
  );
  if (!rejection) return null;
  return {
    classification: 'rejected',
    reason: `门禁命令仍被授权策略拒绝（rejected）：${rejection}。策略不变时重跑结果相同。`,
    hint: '调整 .tekon/repo-profile.yaml 中的命令或移除危险参数（shell 元字符、网络、递归强制删除、force push 等）后恢复运行。',
  };
}
