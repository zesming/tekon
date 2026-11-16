import type { RunProviderConfig } from '../types/domain.js';
import type { BoundRepoCommand } from './repo-command-binding.js';
import {
  canonicalJson,
  captureRunPlan,
  type RunPlanContext,
  type RunPlanV3,
} from './run-plan.js';

/**
 * PD-05：运行默认按受理时冻结的绑定恢复。`--rebind` 显式采用当前配置时，
 * 可重绑定面只有三类执行事实：
 * 1. plan.agent（运行选用的 agent）；
 * 2. run_provider_configs（provider 名称及其配置摘要）；
 * 3. plan.repoCommands（repo-profile / package.json 物化的门禁命令）。
 * 模板结构（phases/nodes/gates 定义）由 nodes 持久行与审计哈希链锚定，
 * 不属于可重绑定面：结构变更必须发起新运行。
 */

export interface RecaptureRunPlanInput {
  repoPath: string;
  frozenPlan: RunPlanV3;
  /** 显式切换 agent；缺省沿用冻结 agent，不解析仓库当前默认值。 */
  agent?: string;
}

/**
 * 用冻结模板原字节与当前仓库命令事实重新捕获 RunPlanV3。上下文（mode、
 * profile、超时、templateId 等）全部从冻结计划继承，只有显式传入的
 * agent 可覆盖；返回的计划自带自洽 digest。
 */
export function recaptureRunPlan(input: RecaptureRunPlanInput): RunPlanV3 {
  const { repoPath, frozenPlan } = input;
  const context: RunPlanContext = {
    agent: input.agent ?? frozenPlan.agent,
    mode: frozenPlan.mode,
    ...(frozenPlan.profile !== undefined
      ? { profile: frozenPlan.profile }
      : {}),
    ...(frozenPlan.allowDirtyBase !== undefined
      ? { allowDirtyBase: frozenPlan.allowDirtyBase }
      : {}),
    ...(frozenPlan.timeoutMs !== undefined
      ? { timeoutMs: frozenPlan.timeoutMs }
      : {}),
    ...(frozenPlan.noProgressTimeoutMs !== undefined
      ? { noProgressTimeoutMs: frozenPlan.noProgressTimeoutMs }
      : {}),
    ...(frozenPlan.progressHeartbeatMs !== undefined
      ? { progressHeartbeatMs: frozenPlan.progressHeartbeatMs }
      : {}),
    ...(frozenPlan.templateId !== undefined
      ? { templateId: frozenPlan.templateId }
      : {}),
    ...(frozenPlan.templateVersion !== undefined
      ? { templateVersion: frozenPlan.templateVersion }
      : {}),
  };
  return captureRunPlan(repoPath, frozenPlan.template, context);
}

export interface RepoCommandBindingDifference {
  commandRef: string;
  frozen: BoundRepoCommand;
  current: BoundRepoCommand;
}

export interface ProviderBindingDifference {
  fromProvider: RunProviderConfig['provider'];
  toProvider: RunProviderConfig['provider'];
  /** 名称未变但 configSummary 变化（如 profile、超时、许可基线）。 */
  configChanged: boolean;
}

export interface BindingDiff {
  hasDifferences: boolean;
  agent: { from: string; to: string } | null;
  provider: ProviderBindingDifference | null;
  repoCommands: RepoCommandBindingDifference[];
}

/**
 * 纯比较：冻结绑定 vs 当前重捕获绑定。canonical JSON 比较保证键序无关；
 * 不做任何 IO，也不脱敏——调用方在写审计或对外投影前负责 redactSecrets。
 */
export function diffRunBindings(input: {
  frozenPlan: RunPlanV3;
  currentPlan: RunPlanV3;
  frozenProvider: RunProviderConfig;
  currentProvider: RunProviderConfig;
}): BindingDiff {
  const { frozenPlan, currentPlan, frozenProvider, currentProvider } = input;

  const agent =
    frozenPlan.agent === currentPlan.agent
      ? null
      : { from: frozenPlan.agent, to: currentPlan.agent };

  const configChanged =
    canonicalJson(frozenProvider.configSummary) !==
    canonicalJson(currentProvider.configSummary);
  const provider =
    frozenProvider.provider === currentProvider.provider && !configChanged
      ? null
      : {
          fromProvider: frozenProvider.provider,
          toProvider: currentProvider.provider,
          configChanged,
        };

  const frozenByRef = new Map(
    frozenPlan.repoCommands.map((entry) => [entry.commandRef, entry]),
  );
  const currentByRef = new Map(
    currentPlan.repoCommands.map((entry) => [entry.commandRef, entry]),
  );
  const refs = [
    ...new Set([...frozenByRef.keys(), ...currentByRef.keys()]),
  ].sort();
  const repoCommands: RepoCommandBindingDifference[] = [];
  for (const commandRef of refs) {
    const frozen = frozenByRef.get(commandRef);
    const current = currentByRef.get(commandRef);
    // 同一冻结模板的引用集合必然相同；出现单边缺失说明模板被换过，属
    // 结构变更，不在本函数的可重绑定语义内，直接跳过不计。
    if (!frozen || !current) continue;
    if (canonicalJson(frozen) !== canonicalJson(current)) {
      repoCommands.push({ commandRef, frozen, current });
    }
  }

  return {
    hasDifferences:
      agent !== null || provider !== null || repoCommands.length > 0,
    agent,
    provider,
    repoCommands,
  };
}

/**
 * 只读绑定探测：用当前仓库配置重捕获计划并与冻结绑定比较，供 `status` 与裸
 * `resume` 输出差异提示。该路径不构建新引擎，无法得知当前 provider 快照，
 * 因此 provider 段恒为 null（计划层的 agent 与 repoCommands 差异仍完整）；
 * 要采用差异必须走显式 --rebind。
 */
export function inspectCurrentBinding(input: {
  repoPath: string;
  frozenPlan: RunPlanV3;
  frozenProvider: RunProviderConfig;
}): BindingDiff {
  const currentPlan = recaptureRunPlan({
    repoPath: input.repoPath,
    frozenPlan: input.frozenPlan,
  });
  return diffRunBindings({
    frozenPlan: input.frozenPlan,
    currentPlan,
    frozenProvider: input.frozenProvider,
    currentProvider: input.frozenProvider,
  });
}
