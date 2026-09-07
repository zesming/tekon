import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { hashAdmissionEnvelope } from "@tekon/core";

import type { ProjectRunIntent } from "./context.js";

/**
 * 只规范化用户提交，不读取变化中的模板、需求卡或 Provider 默认配置。
 * admissionIntent 与 project.run 共用；token/requestId 不属于提交意图。
 */
export function webRunEnvelope(projectRoot: string, input: ProjectRunIntent) {
  const mode = input.mode ?? "workflow";
  return {
    version: 1,
    scope: realpathSync(projectRoot),
    demandTextOrRef: JSON.stringify(input.demandShapePath
      ? { kind: "draft-reference", path: resolve(input.demandShapePath) }
      : { kind: "text", text: input.demandText.trim() }),
    mode,
    templateName: mode === "goal" ? "goal" : input.template?.trim() || "standard-delivery",
    profile: input.profile ?? "human-web",
    agent: input.agent ?? "codex",
    allowDirtyBase: Boolean(input.allowDirtyBase),
    acknowledgeUnrestrictedNetwork: Boolean(input.acknowledgeUnrestrictedNetwork),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.noProgressTimeoutMs !== undefined ? { noProgressTimeoutMs: input.noProgressTimeoutMs } : {}),
    ...(input.progressHeartbeatMs !== undefined ? { progressHeartbeatMs: input.progressHeartbeatMs } : {}),
    ...(input.planDigest !== undefined ? { planDigest: input.planDigest } : {}),
  };
}

export function hashWebRunEnvelope(projectRoot: string, input: ProjectRunIntent): string {
  const env = webRunEnvelope(projectRoot, input);
  return hashAdmissionEnvelope(env);
}
