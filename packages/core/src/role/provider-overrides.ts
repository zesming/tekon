import type { RoleProviderOverrides } from '../runtime/agent-adapter.js';
import type { RunProviderConfig } from '../types/domain.js';
import type { LoadedRole } from './loader.js';
import { assertSafeProviderOverrideValue } from './override-safety.js';

/**
 * PD-10：把角色 agent.yaml 的 provider 覆盖解析为适配器输入。
 *
 * 边界：
 * - mock 是测试适配器，不参与 driver 裁决并忽略 model/effort（返回 undefined）。
 * - 真实 provider 下，角色声明的 driver 与 run 级 provider 不符时显式失败——
 *   一个 run 只有一个 adapter 实例，无法在节点间切换 harness，静默忽略会让
 *   角色声明失真。
 * - 不写 model/effort 时返回 undefined，适配器沿用 run 级默认值，零变化。
 */
export function resolveRoleProviderOverrides(
  runId: string,
  role: string,
  loadedRole: LoadedRole,
  providerConfig: RunProviderConfig | null,
): RoleProviderOverrides | undefined {
  const agent = loadedRole.agent;
  const hasOverrides = agent.model !== undefined || agent.effort !== undefined;
  if (!hasOverrides && agent.driver === undefined) return undefined;

  const provider = providerConfig?.provider ?? 'mock';
  if (provider === 'mock') return undefined;

  // 统一字符白名单（纵深防御）：无论哪个适配器消费，覆盖值在进入任何
  // argv 构建前就必须是安全标识符，杜绝选项/Shell 元字符注入。
  if (agent.driver !== undefined) {
    assertSafeProviderOverrideValue('driver', agent.driver);
  }

  if (agent.driver !== undefined && agent.driver !== provider) {
    throw new Error(
      `ROLE_DRIVER_MISMATCH: 角色 ${role} 声明 driver=${agent.driver}，但运行 ${runId} 的 provider 是 ${provider}；同一运行不能按节点切换 harness，请移除角色 driver 声明或用匹配的 provider 发起新运行。`,
    );
  }

  if (!hasOverrides) return undefined;
  if (agent.model !== undefined) {
    assertSafeProviderOverrideValue('model', agent.model);
  }
  if (agent.effort !== undefined) {
    assertSafeProviderOverrideValue('effort', agent.effort);
  }
  return {
    ...(agent.model !== undefined ? { model: agent.model } : {}),
    ...(agent.effort !== undefined ? { effort: agent.effort } : {}),
  };
}
