import type { TekonRepositories } from '../db/repositories.js';
import type { AuditLogger } from '../audit/logger.js';
import type { GateConfig, RunProviderConfig } from '../types/domain.js';
import { redactSecrets } from '../security/secrets.js';
import { runPlanToExecutionPlan } from './execution-plan.js';
import {
  canonicalJson,
  validateRunPlanV3,
  type RunPlanV3,
} from './run-plan.js';
import {
  diffRunBindings,
  recaptureRunPlan,
  type BindingDiff,
} from './rebind.js';

export type { BindingDiff } from './rebind.js';

/**
 * PD-05：显式 --rebind 的落库编排。默认恢复永远使用受理时冻结的绑定；只有
 * 本函数会把当前仓库配置“转正”为新的冻结身份：
 * - 用冻结模板原字节重捕获 RunPlanV3（上下文继承，仅显式 agent 可覆盖）；
 * - 一个事务内替换 plan_snapshot/plan_digest、upsert provider 快照，并重写
 *   非终态节点（含历史返工节点）的物化门禁；
 * - 已通过节点的 gate_results 与审计哈希链不动，历史证据保持可验。
 */
export interface RebindRunBindingInput {
  repoPath: string;
  runId: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  /** 显式切换 agent；缺省沿用冻结 agent。 */
  agent?: string;
  /** 调用方按当前配置构建的新 provider 快照（与目标 agent 对应）。 */
  currentProvider: RunProviderConfig;
}

export interface RebindRunBindingResult {
  plan: RunPlanV3;
  previousDigest: string;
  diff: BindingDiff;
}

/** 返工节点 id（新旧两种格式）→ 其目标节点 id。 */
function reworkTargetNodeId(nodeId: string): string | null {
  const match = /^(.*)_rework_\d+(?:_[0-9a-f]{8})?$/u.exec(nodeId);
  return match ? match[1] : null;
}

export async function rebindRunBinding(
  input: RebindRunBindingInput,
): Promise<RebindRunBindingResult> {
  const { repositories, runId } = input;
  const workflow = await repositories.getWorkflowInstance(runId);
  if (!workflow) {
    throw new Error(`REBIND_RUN_NOT_FOUND: ${runId}`);
  }
  if (
    workflow.status === 'passed' ||
    workflow.status === 'failed' ||
    workflow.status === 'cancelled'
  ) {
    throw new Error(
      `REBIND_TERMINAL: 运行 ${runId} 已处于终态 ${workflow.status}，不能重绑定；请发起新运行。`,
    );
  }
  if (!workflow.planSnapshot) {
    throw new Error(
      `REBIND_PLAN_UNSUPPORTED: 运行 ${runId} 没有冻结计划快照，无可重绑定的绑定身份。`,
    );
  }

  let frozenPlan: RunPlanV3;
  try {
    frozenPlan = validateRunPlanV3(JSON.parse(workflow.planSnapshot));
  } catch {
    throw new Error(
      `REBIND_PLAN_UNSUPPORTED: 运行 ${runId} 的冻结计划不是 v3 格式，--rebind 仅支持当前版本受理的运行。`,
    );
  }

  const frozenProvider = await repositories.getRunProviderConfig(runId);
  if (!frozenProvider) {
    throw new Error(
      `REBIND_PROVIDER_SNAPSHOT_MISSING: 运行 ${runId} 没有 provider 快照，无法安全重绑定。`,
    );
  }

  const plan = recaptureRunPlan({
    repoPath: input.repoPath,
    frozenPlan,
    ...(input.agent !== undefined ? { agent: input.agent } : {}),
  });
  const diff = diffRunBindings({
    frozenPlan,
    currentPlan: plan,
    frozenProvider,
    currentProvider: input.currentProvider,
  });

  // 新计划物化后的节点门禁，按 run-scoped 节点 id 索引；返工节点从其目标
  // 节点继承同一组门禁（与 deriveReworkNode 的继承规则一致）。
  const materialized = runPlanToExecutionPlan(plan, runId);
  const gatesByNodeId = new Map<string, GateConfig[]>();
  for (const phase of materialized.phases) {
    for (const node of phase.nodes) {
      gatesByNodeId.set(node.id, node.gates as GateConfig[]);
    }
  }
  const nodeGates: Array<{ nodeId: string; gates: GateConfig[] }> = [];
  for (const node of await repositories.listNodes(runId)) {
    const fresh =
      gatesByNodeId.get(node.id) ??
      (reworkTargetNodeId(node.id)
        ? gatesByNodeId.get(reworkTargetNodeId(node.id)!)
        : undefined);
    // 计划外节点（如 repair 节点，门禁为空）与无变化节点不写。
    if (fresh && canonicalJson(fresh) !== canonicalJson(node.gates)) {
      nodeGates.push({ nodeId: node.id, gates: fresh });
    }
  }

  const provider: RunProviderConfig = {
    ...input.currentProvider,
    runId,
  };
  const outcome = await repositories.applyRunRebind({
    runId,
    planSnapshot: canonicalJson(plan),
    planDigest: plan.digest,
    provider,
    nodeGates,
    // 零差异时事务只跑安全守卫、跳过实际 UPDATE。
    unchanged: !diff.hasDifferences,
  });
  if (!outcome.applied) {
    // 并发终态/活跃作业写入赢了竞争：事务守卫拒绝，保持既有状态权威。
    if (outcome.reason === 'active-job') {
      throw new Error(
        `REBIND_ACTIVE_JOB: 运行 ${runId} 有活跃作业，不能在执行期间重绑定；请等待作业完成或先 tekon cancel。`,
      );
    }
    const latest = await repositories.getWorkflowInstance(runId);
    throw new Error(
      `REBIND_TERMINAL: 运行 ${runId} 已进入终态 ${latest?.status ?? 'unknown'}，重绑定被拒绝。`,
    );
  }

  // 零差异：绑定身份未变，不写审计噪声（安全守卫已在事务内执行）。
  if (!diff.hasDifferences) {
    return {
      plan,
      previousDigest: workflow.planDigest ?? '',
      diff,
    };
  }

  await input.audit.append({
    runId,
    type: 'run.rebound',
    payload: JSON.parse(
      redactSecrets(
        canonicalJson({
          previousDigest: workflow.planDigest,
          nextDigest: plan.digest,
          diff,
        }),
      ).content,
    ) as Record<string, unknown>,
  });

  return {
    plan,
    previousDigest: workflow.planDigest ?? '',
    diff,
  };
}
