import path from "node:path";
import { classifyIntent } from "./intent.js";
import { planWorkflow } from "./workflow.js";
import { runCommand } from "./tool-gateway.js";
import { ensureDir, writeJson } from "./fs-store.js";
import { writeHtmlReport, writeTextEvidence } from "./evidence.js";
import type { EvidenceItem, ProjectRun, RepoProfile, TargetStage, ToolRun } from "./types.js";
import { redactSensitive } from "./redact.js";

export interface RunProjectOptions {
  input: string;
  repoProfile: RepoProfile;
  workspaceRoot: string;
  requestedTargetStage?: TargetStage;
  dryRun?: boolean;
}

export async function runProject(options: RunProjectOptions): Promise<ProjectRun> {
  const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const outputDir = path.join(options.workspaceRoot, ".donkey", "runs", runId);
  await ensureDir(outputDir);

  const intent = classifyIntent({
    input: options.input,
    repoProfile: options.repoProfile,
    requestedTargetStage: options.requestedTargetStage,
  });
  const workflow = planWorkflow(intent);
  const evidence: EvidenceItem[] = [];
  const toolRuns: ToolRun[] = [];

  if (intent.targetStage === "risk_report") {
    evidence.push(
      await writeTextEvidence({
        workspaceRoot: options.workspaceRoot,
        outputDir,
        type: "risk_report",
        title: "风险报告",
        fileName: "risk-report.md",
        content: renderRiskReport(redactSensitive(options.input), intent.reasons),
        summary: "高危需求已降级为风险报告，未执行工具命令",
      }),
    );
  } else if (intent.targetStage === "demand_doc") {
    evidence.push(
      await writeTextEvidence({
        workspaceRoot: options.workspaceRoot,
        outputDir,
        type: "document",
        title: "需求文档草案",
        fileName: "demand.md",
        content: renderDemandDoc(redactSensitive(options.input), intent.missingInfo),
        summary: "从想法生成的需求文档草案",
      }),
    );
  } else if (intent.targetStage === "tech_plan" || intent.targetStage === "task_breakdown") {
    evidence.push(
      await writeTextEvidence({
        workspaceRoot: options.workspaceRoot,
        outputDir,
        type: "document",
        title: "技术方案草案",
        fileName: "technical-plan.md",
        content: renderTechnicalPlan(redactSensitive(options.input)),
        summary: "从需求生成的技术方案草案",
      }),
    );
  }

  if (shouldRunValidation(intent.targetStage) && !options.dryRun) {
    const testCommand = options.repoProfile.commands.test;
    if (testCommand) {
      const toolRun = await runCommand({
        command: testCommand,
        cwd: options.workspaceRoot,
        repoProfile: options.repoProfile,
        outputDir,
      });
      toolRuns.push(toolRun);
      evidence.push(
        await writeTextEvidence({
          workspaceRoot: options.workspaceRoot,
          outputDir,
          type: "test_report",
          title: "测试报告",
          fileName: "test-report.md",
          content: renderTestReport(toolRun),
          summary: toolRun.status === "passed" ? "测试命令通过" : "测试命令未通过",
        }),
      );
    } else {
      evidence.push(
        await writeTextEvidence({
          workspaceRoot: options.workspaceRoot,
          outputDir,
          type: "test_report",
          title: "测试缺口",
          fileName: "test-gap.md",
          content: "Repo Profile 未配置测试命令，验收项标记为未覆盖。\n",
          summary: "缺少测试命令",
        }),
      );
    }
  }

  const status = computeStatus(intent.targetStage, toolRuns);
  const run: ProjectRun = {
    schemaVersion: 1,
    id: runId,
    createdAt: new Date().toISOString(),
    input: redactSensitive(options.input),
    intent,
    workflow,
    status,
    toolRuns,
    evidence,
    outputDir,
    recommendedDecision: recommendedDecision(intent.targetStage, status),
    events: [
      {
        at: new Date().toISOString(),
        type: "IntentClassified",
        message: `输入类型 ${intent.inputType}，目标阶段 ${intent.targetStage}`,
      },
      {
        at: new Date().toISOString(),
        type: "WorkflowPlanned",
        message: `生成 ${workflow.stages.length} 个阶段，跳过 ${workflow.stages.filter((stage) => stage.skipped).length} 个阶段`,
      },
      ...toolRuns.map((tool) => ({
        at: new Date().toISOString(),
        type: "ToolRunCompleted",
        message: `${tool.command} -> ${tool.status}`,
      })),
    ],
  };
  const htmlEvidence = await writeHtmlReport(run, options.workspaceRoot);
  run.evidence.push(htmlEvidence);
  await writeJson(path.join(outputDir, "state.json"), run);
  return run;
}

function shouldRunValidation(targetStage: TargetStage): boolean {
  return targetStage === "validation_report" || targetStage === "pull_request";
}

function computeStatus(targetStage: TargetStage, toolRuns: ToolRun[]): ProjectRun["status"] {
  if (targetStage === "risk_report") {
    return "blocked";
  }
  if (toolRuns.some((tool) => tool.status === "blocked")) {
    return "blocked";
  }
  if (toolRuns.some((tool) => tool.status === "failed")) {
    return "failed";
  }
  return "completed";
}

function recommendedDecision(targetStage: TargetStage, status: ProjectRun["status"]): ProjectRun["recommendedDecision"] {
  if (targetStage === "risk_report" || status === "blocked") {
    return "blocked";
  }
  if (status === "failed") {
    return "review";
  }
  return "accept";
}

function renderRiskReport(input: string, reasons: string[]): string {
  return `# 风险报告\n\n## 输入\n\n${input}\n\n## 判断依据\n\n${reasons.map((reason) => `- ${reason}`).join("\n")}\n\n## 处理结论\n\n不自动执行危险动作，请人工确认后拆分为可控任务。\n`;
}

function renderDemandDoc(input: string, missingInfo: string[]): string {
  return `# 需求文档草案\n\n## 原始想法\n\n${input}\n\n## 初始目标\n\n将想法整理为可评审需求，并补齐验收标准。\n\n## 信息缺口\n\n${missingInfo.map((item) => `- ${item}`).join("\n") || "- 无"}\n`;
}

function renderTechnicalPlan(input: string): string {
  return `# 技术方案草案\n\n## 输入需求\n\n${input}\n\n## 方案摘要\n\n基于现有需求生成最小可执行方案，后续进入任务拆解和验证。\n\n## 风险\n\n- 需要结合 Repo Profile 确认测试入口和高危边界。\n`;
}

function renderTestReport(toolRun: ToolRun): string {
  return `# 测试报告\n\n- 命令：\`${toolRun.command}\`\n- 状态：${toolRun.status}\n- 退出码：${toolRun.exitCode ?? "无"}\n- stdout：${toolRun.stdoutPath ?? "无"}\n- stderr：${toolRun.stderrPath ?? "无"}\n`;
}
