export type InputType =
  | "idea"
  | "demand"
  | "tech_plan"
  | "task_list"
  | "code_change"
  | "pull_request"
  | "review_only";

export type TargetStage =
  | "demand_doc"
  | "tech_plan"
  | "task_breakdown"
  | "development"
  | "validation_report"
  | "pull_request"
  | "risk_report";

export type RiskLevel = "low" | "medium" | "high";

export interface IntentResult {
  inputType: InputType;
  targetStage: TargetStage;
  confidence: number;
  riskLevel: RiskLevel;
  missingInfo: string[];
  reasons: string[];
}

export interface RepoProfile {
  id: string;
  name: string;
  root: string;
  commands: {
    test?: string;
    lint?: string;
    typecheck?: string;
    e2e?: string;
  };
  risk: {
    highRiskKeywords: string[];
    blockedCommandPatterns: string[];
    allowedCommandPatterns: string[];
    highRiskPaths: string[];
  };
}

export interface AgentProfile {
  name: string;
  version: string;
  role: string;
  description: string;
  tools: string[];
  skills: string[];
  permissions: {
    allow: string[];
    deny: string[];
  };
}

export interface WorkflowDefinition {
  name: string;
  version: string;
  supportedInputTypes: InputType[];
  targetStages: TargetStage[];
}

export interface WorkflowStage {
  id: string;
  title: string;
  agentProfile: string;
  skipped: boolean;
  skipReason?: string;
}

export interface WorkflowPlan {
  definition: string;
  version: string;
  inputType: InputType;
  targetStage: TargetStage;
  stages: WorkflowStage[];
}

export interface ToolRun {
  id: string;
  command: string;
  cwd: string;
  status: "passed" | "failed" | "blocked";
  exitCode: number | null;
  durationMs: number;
  stdoutPath?: string;
  stderrPath?: string;
  reason?: string;
}

export interface EvidenceItem {
  id: string;
  type: "document" | "test_report" | "risk_report" | "tool_log" | "html_report";
  title: string;
  path: string;
  summary: string;
}

export interface ProjectRun {
  schemaVersion: 1;
  id: string;
  createdAt: string;
  input: string;
  intent: IntentResult;
  workflow: WorkflowPlan;
  status: "completed" | "blocked" | "failed";
  toolRuns: ToolRun[];
  evidence: EvidenceItem[];
  outputDir: string;
  recommendedDecision: "accept" | "review" | "blocked";
  events: Array<{
    at: string;
    type: string;
    message: string;
  }>;
}

export interface EvalCase {
  id: string;
  input: string;
  expectedInputType: InputType;
  expectedTargetStage: TargetStage;
  forbiddenTargetStages?: TargetStage[];
}

export interface EvalResult {
  id: string;
  passed: boolean;
  expectedInputType: InputType;
  actualInputType: InputType;
  expectedTargetStage: TargetStage;
  actualTargetStage: TargetStage;
  reasons: string[];
}
