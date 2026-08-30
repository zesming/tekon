import { createHash } from "node:crypto";

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
  digest: string;
  roleChain: Role[];
  gates: RunPlanGate[];
  requiresUnrestrictedNetwork: boolean;
  phases: RunPlanPhaseSummary[];
  agent: string;
  profile?: string;
  allowDirtyBase?: boolean;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  progressHeartbeatMs?: number;
  templateId?: string;
  templateVersion?: number | string;
}

export interface RunPlanContext {
  agent?: string;
  mode?: "workflow" | "goal";
  profile?: string;
  allowDirtyBase?: boolean;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  progressHeartbeatMs?: number;
  templateId?: string;
  templateVersion?: number | string;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => key !== "digest" && obj[key] !== undefined)
    .sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`,
  );
  return `{${entries.join(",")}}`;
}

export function computeRunPlanDigest(
  plan: Omit<RunPlan, "digest"> | RunPlan,
): string {
  const canonical = canonicalJson(plan);
  return createHash("sha256").update(canonical).digest("hex");
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
 * - Normalizes agent to 'codex' if omitted.
 * - Includes execution configuration (profile, allowDirtyBase, timeouts, templateId, templateVersion).
 * - Computes and attaches a deterministic digest of the plan.
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

  const agent = context.agent ?? "codex";
  const requiresUnrestrictedNetwork = agentRequiresUnrestrictedNetwork(agent);
  const templateId = context.templateId ?? template.id;
  const templateVersion = context.templateVersion ?? template.version;

  const planWithoutDigest: Omit<RunPlan, "digest"> = {
    roleChain,
    gates,
    requiresUnrestrictedNetwork,
    phases,
    agent,
    ...(context.profile !== undefined ? { profile: context.profile } : {}),
    ...(context.allowDirtyBase !== undefined
      ? { allowDirtyBase: context.allowDirtyBase }
      : {}),
    ...(context.timeoutMs !== undefined
      ? { timeoutMs: context.timeoutMs }
      : {}),
    ...(context.noProgressTimeoutMs !== undefined
      ? { noProgressTimeoutMs: context.noProgressTimeoutMs }
      : {}),
    ...(context.progressHeartbeatMs !== undefined
      ? { progressHeartbeatMs: context.progressHeartbeatMs }
      : {}),
    ...(templateId !== undefined ? { templateId } : {}),
    ...(templateVersion !== undefined ? { templateVersion } : {}),
  };

  const digest = computeRunPlanDigest(planWithoutDigest);

  return {
    digest,
    ...planWithoutDigest,
  };
}
