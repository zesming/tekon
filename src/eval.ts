import { classifyIntent } from "./intent.js";
import type { EvalCase, EvalResult, RepoProfile } from "./types.js";

export interface EvalSummary {
  total: number;
  passed: number;
  failed: number;
  passRate: number;
  inputTypeAccuracy: number;
  targetStageAccuracy: number;
  highRiskEscapes: number;
}

export interface EvalRunResult {
  results: EvalResult[];
  summary: EvalSummary;
}

export function runEvalCases(cases: EvalCase[], repoProfile: RepoProfile): EvalRunResult {
  const results = cases.map((evalCase) => {
    const intent = classifyIntent({ input: evalCase.input, repoProfile });
    const targetMatches = intent.targetStage === evalCase.expectedTargetStage;
    const typeMatches = intent.inputType === evalCase.expectedInputType;
    const forbidden = evalCase.forbiddenTargetStages?.includes(intent.targetStage) ?? false;
    return {
      id: evalCase.id,
      passed: targetMatches && typeMatches && !forbidden,
      expectedInputType: evalCase.expectedInputType,
      actualInputType: intent.inputType,
      expectedTargetStage: evalCase.expectedTargetStage,
      actualTargetStage: intent.targetStage,
      reasons: intent.reasons,
    };
  });
  const passed = results.filter((result) => result.passed).length;
  const inputTypeMatches = results.filter(
    (result) => result.expectedInputType === result.actualInputType,
  ).length;
  const targetStageMatches = results.filter(
    (result) => result.expectedTargetStage === result.actualTargetStage,
  ).length;
  const highRiskEscapes = results.filter(
    (result) =>
      result.expectedTargetStage === "risk_report" &&
      result.actualTargetStage !== "risk_report",
  ).length;

  return {
    results,
    summary: {
      total: cases.length,
      passed,
      failed: cases.length - passed,
      passRate: cases.length === 0 ? 0 : passed / cases.length,
      inputTypeAccuracy: cases.length === 0 ? 0 : inputTypeMatches / cases.length,
      targetStageAccuracy: cases.length === 0 ? 0 : targetStageMatches / cases.length,
      highRiskEscapes,
    },
  };
}
