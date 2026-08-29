import type { GateType, Role } from "../types/domain.js";
import type { WorkflowTemplate } from "./template.js";

export interface RunPlanGate {
  nodeId: string;
  role: Role;
  type: GateType;
  requiresHumanApproval: boolean;
  timeoutMs?: number;
}

export interface RunPlanPhaseSummary {
  id: string;
  name: string;
  parallel: boolean;
  nodeIds: string[];
}

export interface RunPlan {
  roleChain: Role[];
  gates: RunPlanGate[];
  requiresUnrestrictedNetwork: boolean;
  phases: RunPlanPhaseSummary[];
}

export interface RunPlanContext {
  agent?: string;
  mode?: "workflow" | "goal";
}

/**
 * 当前唯一 network=enabled 且需知情确认的 provider 是 dsh-headless（见 runtime/agent-adapter.ts fail-closed 守卫），
 * 此函数是 plan/router 共用的单一判据，新增 enabled provider 时改这一处。
 */
export function agentRequiresUnrestrictedNetwork(
  agent: string | undefined,
): boolean {
  return agent === "dsh-headless";
}

/**
 * Pure projection from a WorkflowTemplate and run context to a human-readable RunPlan.
 * - Extracts roleChain in execution order across phases/nodes.
 * - Extracts all gates with their nodeId, role, type, requiresHumanApproval, and optional timeoutMs.
 * - Summarizes phases with id, name, parallel flag, and nodeIds.
 * - Sets requiresUnrestrictedNetwork via agentRequiresUnrestrictedNetwork.
 */
export function projectRunPlan(
  template: WorkflowTemplate,
  context: RunPlanContext = {},
): RunPlan {
  const roleChain: Role[] = [];
  const gates: RunPlanGate[] = [];
  const phases: RunPlanPhaseSummary[] = [];

  for (const phase of template.phases) {
    const nodeIds: string[] = [];
    for (const node of phase.nodes) {
      nodeIds.push(node.id);
      roleChain.push(node.role);
      for (const gate of node.gates) {
        gates.push({
          nodeId: node.id,
          role: node.role,
          type: gate.type,
          requiresHumanApproval: gate.requiresHumanApproval,
          ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {}),
        });
      }
    }
    phases.push({
      id: phase.id,
      name: phase.name,
      parallel: phase.parallel,
      nodeIds,
    });
  }

  const requiresUnrestrictedNetwork = agentRequiresUnrestrictedNetwork(
    context.agent,
  );

  return {
    roleChain,
    gates,
    requiresUnrestrictedNetwork,
    phases,
  };
}
