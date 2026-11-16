import type { GateResult, HumanDecision, Node } from '../types/domain.js';
import { gatesWithStableKeys } from './workflow-runtime.js';
import type { ExecutableNode } from './workflow-runtime.js';
import type { WorkflowGateConfig } from './template.js';

/**
 * PD-18：人工驳回返工的触发判定。blocked 节点 resume 时，若节点的 human
 * gate 声明了返工目标、存在同节点的 rejected 决策，且该决策尚未触发过返
 * 工，则返回返工所需的全部参数；否则返回 null（走常规 blocked 恢复）。
 */
export interface HumanReworkTrigger {
  gate: WorkflowGateConfig;
  gateResult: GateResult;
  decision: HumanDecision;
  /** 返工目标的 run-scoped 节点 id。 */
  targetNodeId: string;
  attempt: number;
  feedbackNote: string;
}

/** 节点行 id 形如 `<runId>_<templateNodeId>`，剥掉运行前缀得到模板 id。 */
function templateNodeId(runScopedId: string, runId: string): string {
  const prefix = `${runId}_`;
  return runScopedId.startsWith(prefix)
    ? runScopedId.slice(prefix.length)
    : runScopedId;
}

export function resolveHumanReworkTrigger(input: {
  runId: string;
  node: ExecutableNode;
  nodes: Node[];
  gateResults: GateResult[];
  decisions: HumanDecision[];
  /** 该 run 已有的返工审计事件，用于防重复与 attempt 计数。 */
  reworkAttemptEvents: Array<{
    payload: { gateResultId?: unknown };
  }>;
}): HumanReworkTrigger | null {
  const humanGate = gatesWithStableKeys(input.node.gates, input.node.id).find(
    (gate) => gate.type === 'human' && gate.reworkTargetNodeId,
  );
  if (!humanGate?.reworkTargetNodeId) return null;

  // 同节点最新的 rejected 决策。
  const decision = [...input.decisions]
    .reverse()
    .find(
      (item) => item.nodeId === input.node.id && item.status === 'rejected',
    );
  if (!decision) return null;

  // 该 human gate 最新一个 failed/human-rejected 的门禁结果。
  const gateResult = [...input.gateResults]
    .reverse()
    .find(
      (result) =>
        result.nodeId === input.node.id &&
        result.gateType === 'human' &&
        result.status === 'failed' &&
        result.failureClassification === 'human-rejected',
    );
  if (!gateResult) return null;

  // 防重复：同一门禁结果已经触发过返工就不再触发（resume 幂等）。
  const alreadyReworked = input.reworkAttemptEvents.some(
    (event) => event.payload.gateResultId === gateResult.id,
  );
  if (alreadyReworked) return null;

  // 模板节点 id → run-scoped 节点 id。
  const targetNode = input.nodes.find(
    (item) =>
      item.runId === input.runId &&
      templateNodeId(item.id, input.runId) === humanGate.reworkTargetNodeId,
  );
  if (!targetNode) return null;

  const priorAttempts = input.reworkAttemptEvents.filter(
    (event) => event.payload.gateResultId === gateResult.id,
  ).length;

  return {
    gate: humanGate,
    gateResult,
    decision,
    targetNodeId: targetNode.id,
    attempt: priorAttempts + 1,
    feedbackNote: decision.note?.trim()
      ? decision.note
      : 'Human reviewer rejected the gate without a note.',
  };
}
