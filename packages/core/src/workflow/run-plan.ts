import { createHash } from "node:crypto";
import { z } from 'zod';

import type { GateType, Role } from "../types/domain.js";
import {
  normalizeExecutableTemplate,
  type WorkflowTemplate,
} from "./template.js";

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
  digestVersion: 2;
  mode: "workflow" | "goal";
  template: WorkflowTemplate;
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

export interface RunPlanPreview {
  digest: string;
  digestVersion: 2;
  mode: "workflow" | "goal";
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

/**
 * Standard canonical JSON: sorts object keys and strips undefined values,
 * but PRESERVES nested keys named "digest" (e.g. command.env.digest).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => obj[key] !== undefined)
    .sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`,
  );
  return `{${entries.join(",")}}`;
}

/**
 * Legacy v1 canonical JSON: recursively filters out any key named "digest".
 * Frozen for backward-compatibility verification.
 */
export function canonicalJsonV1(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJsonV1(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((key) => key !== "digest" && obj[key] !== undefined)
    .sort();
  const entries = keys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJsonV1(obj[key])}`,
  );
  return `{${entries.join(",")}}`;
}

export function computeRunPlanDigestV1(plan: unknown): string {
  const canonical = canonicalJsonV1(plan);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Computes deterministic RunPlan sha256 digest: excludes ONLY the top-level
 * digest key, while preserving inner nested "digest" keys.
 */
export function computeRunPlanDigest(
  plan: Omit<RunPlan, "digest"> | RunPlan | Record<string, unknown>,
): string {
  const { digest: _ignored, ...rest } = plan as Record<string, unknown>;
  const canonical = canonicalJson(rest);
  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Pure whitelist projection from RunPlan to client-safe RunPlanPreview.
 * Excludes template definition and potential secret commands/args/env.
 */
export const toRunPlanPreview = projectRunPlanPreview;
export function projectRunPlanPreview(plan: RunPlan): RunPlanPreview {
  return {
    digest: plan.digest,
    digestVersion: 2,
    mode: plan.mode,
    roleChain: [...plan.roleChain],
    gates: plan.gates.map(gate => ({
      nodeId: gate.nodeId,
      role: gate.role,
      type: gate.type,
      requiresHumanApproval: gate.requiresHumanApproval,
      ...(gate.timeoutMs !== undefined ? { timeoutMs: gate.timeoutMs } : {}),
    })),
    requiresUnrestrictedNetwork: plan.requiresUnrestrictedNetwork,
    phases: plan.phases.map(phase => ({
      id: phase.id,
      name: phase.name,
      parallel: phase.parallel,
      nodeIds: [...phase.nodeIds],
    })),
    agent: plan.agent,
    ...(plan.profile !== undefined ? { profile: plan.profile } : {}),
    ...(plan.allowDirtyBase !== undefined
      ? { allowDirtyBase: plan.allowDirtyBase }
      : {}),
    ...(plan.timeoutMs !== undefined ? { timeoutMs: plan.timeoutMs } : {}),
    ...(plan.noProgressTimeoutMs !== undefined
      ? { noProgressTimeoutMs: plan.noProgressTimeoutMs }
      : {}),
    ...(plan.progressHeartbeatMs !== undefined
      ? { progressHeartbeatMs: plan.progressHeartbeatMs }
      : {}),
    ...(plan.templateId !== undefined ? { templateId: plan.templateId } : {}),
    ...(plan.templateVersion !== undefined
      ? { templateVersion: plan.templateVersion }
      : {}),
  };
}

export function agentRequiresUnrestrictedNetwork(
  agent: string | undefined,
): boolean {
  return agent === "dsh-headless";
}

/**
 * Pure projection from a WorkflowTemplate and run context to a bound RunPlan v2.
 * - Deeply normalizes the template to freeze execution facts before any async operations.
 * - Sets digestVersion: 2 and mode.
 * - Extracts roleChain, gates, and phases summaries.
 * - Normalizes agent to 'codex' if omitted.
 * - Includes execution configuration.
 * - Computes and attaches a deterministic digest over the full template and context.
 */
export function projectRunPlan(
  template: WorkflowTemplate,
  context: RunPlanContext = {},
): RunPlan {
  const normalizedTemplate = normalizeExecutableTemplate(template);

  const roleChain: Role[] = [];
  const gates: RunPlanGate[] = [];
  const phases: RunPlanPhaseSummary[] = [];

  for (const phase of normalizedTemplate.phases) {
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
  const mode = context.mode ?? "workflow";
  const requiresUnrestrictedNetwork = agentRequiresUnrestrictedNetwork(agent);
  const templateId = context.templateId ?? normalizedTemplate.id;
  const templateVersion = context.templateVersion ?? normalizedTemplate.version;

  const planWithoutDigest: Omit<RunPlan, "digest"> = {
    digestVersion: 2,
    mode,
    template: normalizedTemplate,
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

export function computeLegacyV1RunPlanDigest(plan: unknown): string {
  return computeRunPlanDigestV1(plan);
}

const planContextSchema = z.object({
  agent: z.string().min(1),
  mode: z.enum(['workflow', 'goal']),
  profile: z.string().optional(),
  allowDirtyBase: z.boolean().optional(),
  timeoutMs: z.number().int().positive().optional(),
  noProgressTimeoutMs: z.number().int().positive().optional(),
  progressHeartbeatMs: z.number().int().positive().optional(),
  templateId: z.string().min(1).optional(),
  templateVersion: z.union([z.number().int().positive(), z.string().min(1)]).optional(),
});

/** 从已确认内容重新投影，验证版本、完整模板及所有派生展示字段。 */
export function validateRunPlanV2(value: unknown, errorCode = 'PLAN_DIGEST_MISMATCH'): RunPlan {
  const reject = (path: string): never => { throw new Error(`${errorCode}: ${path}`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject('plan');
  const candidate = value as Record<string, unknown>;
  if (candidate.digestVersion !== 2) reject('digestVersion');
  const context = planContextSchema.safeParse(candidate);
  if (!context.success) reject('context');
  let projected: RunPlan;
  try {
    projected = projectRunPlan(candidate.template as WorkflowTemplate, context.data);
  } catch {
    return reject('template');
  }
  if (candidate.digest !== computeRunPlanDigest(candidate)) reject('digest');
  if (canonicalJson(candidate) !== canonicalJson(projected)) reject('projection');
  return projected;
}
