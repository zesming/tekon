import type { IntentResult, RepoProfile, TargetStage } from "./types.js";
import { evaluateInputRisk } from "./policy.js";

export interface ClassifyIntentOptions {
  input: string;
  repoProfile: RepoProfile;
  requestedTargetStage?: TargetStage;
}

export function classifyIntent(options: ClassifyIntentOptions): IntentResult {
  const normalized = options.input.toLowerCase();
  const risk = evaluateInputRisk(options.input, options.repoProfile);
  const reasons: string[] = [];
  const missingInfo: string[] = [];

  if (risk.level === "high") {
    return {
      inputType: inferInputType(normalized),
      targetStage: "risk_report",
      confidence: 0.95,
      riskLevel: "high",
      missingInfo: [],
      reasons: [`命中高危规则：${risk.findings.join(", ")}`],
    };
  }

  const inputType = inferInputType(normalized);
  const targetStage = chooseTargetStage(inputType, normalized, options.requestedTargetStage);
  reasons.push(reasonFor(inputType, targetStage));

  if (inputType === "idea") {
    missingInfo.push("目标仓库", "详细验收标准");
  }

  return {
    inputType,
    targetStage,
    confidence: inputType === "idea" ? 0.72 : 0.84,
    riskLevel: risk.level,
    missingInfo,
    reasons,
  };
}

function inferInputType(normalized: string): IntentResult["inputType"] {
  if (containsAny(normalized, ["pr", "pull request", "merge request", "审 pr", "审一下这个 pr"])) {
    return "pull_request";
  }
  if (containsAny(normalized, ["diff", "代码变更", "本地变更", "改动"])) {
    return "code_change";
  }
  if (containsAny(normalized, ["prd", "需求文档", "需求"])) {
    return "demand";
  }
  if (containsAny(normalized, ["技术方案", "tech plan", "方案"])) {
    return "tech_plan";
  }
  if (containsAny(normalized, ["任务列表", "任务拆解", "todo", "task list"])) {
    return "task_list";
  }
  if (containsAny(normalized, ["评审", "review", "风险如何"])) {
    return "review_only";
  }
  return "idea";
}

function chooseTargetStage(
  inputType: IntentResult["inputType"],
  normalized: string,
  requested?: TargetStage,
): TargetStage {
  if (requested && requested !== "pull_request") {
    return requested;
  }

  if (inputType === "tech_plan") {
    if (isValidationOnlyRequest(normalized)) {
      return "validation_report";
    }
    if (isImplementationRequest(normalized)) {
      return "development";
    }
    return "task_breakdown";
  }

  if (isImplementationRequest(normalized)) {
    return "development";
  }

  const byInputType: Record<IntentResult["inputType"], TargetStage> = {
    idea: "demand_doc",
    demand: "tech_plan",
    task_list: "development",
    code_change: "validation_report",
    pull_request: "validation_report",
    review_only: "risk_report",
    tech_plan: "task_breakdown",
  };

  return requested ?? byInputType[inputType];
}

function reasonFor(inputType: IntentResult["inputType"], targetStage: TargetStage): string {
  return `输入被识别为 ${inputType}，自动推进到 ${targetStage}`;
}

function containsAny(value: string, keywords: string[]): boolean {
  return keywords.some((keyword) => value.includes(keyword.toLowerCase()));
}

function isImplementationRequest(normalized: string): boolean {
  return containsAny(normalized, ["开发", "实现", "写代码", "改代码", "修改代码", "修复", "bugfix", "执行", "落地"]);
}

function isValidationOnlyRequest(normalized: string): boolean {
  return containsAny(normalized, [
    "只验收",
    "仅验收",
    "只做验收",
    "仅做验收",
    "直接验收",
    "直接执行测试",
    "执行测试验收",
    "跑测试",
    "运行测试",
    "run tests",
    "validation only",
  ]);
}
