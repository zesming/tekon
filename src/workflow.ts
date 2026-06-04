import { defaultWorkflowDefinition } from "./defaults.js";
import type { IntentResult, TargetStage, WorkflowPlan, WorkflowStage } from "./types.js";

const STAGE_ORDER: Array<Omit<WorkflowStage, "skipped" | "skipReason"> & { delivers: TargetStage[] }> = [
  {
    id: "demand_document",
    title: "需求文档",
    agentProfile: "pm-agent@0.1.0",
    delivers: ["demand_doc"],
  },
  {
    id: "technical_plan",
    title: "技术方案",
    agentProfile: "tech-agent@0.1.0",
    delivers: ["tech_plan", "task_breakdown"],
  },
  {
    id: "implementation",
    title: "开发执行",
    agentProfile: "rd-agent@0.1.0",
    delivers: ["development", "pull_request"],
  },
  {
    id: "validation",
    title: "测试验收",
    agentProfile: "test-agent@0.1.0",
    delivers: ["validation_report", "pull_request"],
  },
  {
    id: "risk_report",
    title: "风险报告",
    agentProfile: "review-agent@0.1.0",
    delivers: ["risk_report"],
  },
  {
    id: "evidence_package",
    title: "交付证据包",
    agentProfile: "evidence-agent@0.1.0",
    delivers: ["demand_doc", "tech_plan", "task_breakdown", "development", "validation_report", "pull_request", "risk_report"],
  },
];

export function planWorkflow(intent: IntentResult): WorkflowPlan {
  const definition = defaultWorkflowDefinition();
  const stages = STAGE_ORDER.map((stage) => {
    const required = isStageRequired(stage.id, intent);
    return {
      id: stage.id,
      title: stage.title,
      agentProfile: stage.agentProfile,
      skipped: !required,
      skipReason: required ? undefined : skipReason(stage.id, intent),
    };
  });

  return {
    definition: definition.name,
    version: definition.version,
    inputType: intent.inputType,
    targetStage: intent.targetStage,
    stages,
  };
}

function isStageRequired(stageId: string, intent: IntentResult): boolean {
  if (stageId === "evidence_package") {
    return true;
  }

  if (intent.targetStage === "risk_report") {
    return stageId === "risk_report";
  }

  if (intent.inputType === "tech_plan") {
    if (intent.targetStage === "task_breakdown" || intent.targetStage === "tech_plan") {
      return stageId === "technical_plan";
    }
    if (intent.targetStage === "development") {
      return stageId === "implementation";
    }
    if (intent.targetStage === "validation_report") {
      return stageId === "validation";
    }
    if (intent.targetStage === "pull_request") {
      return ["implementation", "validation"].includes(stageId);
    }
  }

  if (intent.inputType === "code_change" || intent.inputType === "pull_request") {
    return stageId === "validation";
  }

  if (intent.inputType === "demand") {
    return stageId === "technical_plan";
  }

  if (intent.targetStage === "demand_doc") {
    return stageId === "demand_document";
  }

  if (intent.targetStage === "tech_plan" || intent.targetStage === "task_breakdown") {
    return ["demand_document", "technical_plan"].includes(stageId);
  }

  if (intent.targetStage === "validation_report") {
    return ["implementation", "validation"].includes(stageId);
  }

  if (intent.targetStage === "pull_request") {
    return ["implementation", "validation"].includes(stageId);
  }

  return false;
}

function skipReason(stageId: string, intent: IntentResult): string {
  if (intent.targetStage === "risk_report") {
    return "目标阶段为风险报告，禁止进入执行型阶段";
  }
  if (intent.inputType === "tech_plan" && stageId === "demand_document") {
    return "用户已提供技术方案，跳过需求梳理";
  }
  if (intent.inputType === "tech_plan" && intent.targetStage === "validation_report" && stageId === "implementation") {
    return "目标阶段为测试验收，本地 Runner 仅执行验证，不声明开发执行";
  }
  return `目标阶段 ${intent.targetStage} 不需要执行 ${stageId}`;
}
