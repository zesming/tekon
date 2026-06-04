import path from "node:path";
import { writeFile } from "node:fs/promises";
import { classifyIntent } from "./intent.js";
import { planWorkflow } from "./workflow.js";
import { runCommand } from "./tool-gateway.js";
import { ensureDir, relativePath, writeJson } from "./fs-store.js";
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
  const blockedReasons: string[] = [];
  let developmentRun: ToolRun | undefined;

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

  if (shouldRunDevelopment(intent.targetStage) && !options.dryRun) {
    const developCommand = options.repoProfile.commands.develop;
    if (!developCommand) {
      blockedReasons.push("Repo Profile 未配置开发命令 commands.develop，无法执行代码修改");
      evidence.push(
        await writeTextEvidence({
          workspaceRoot: options.workspaceRoot,
          outputDir,
          type: "document",
          title: "开发命令缺口",
          fileName: "development-gap.md",
          content: renderDevelopmentGap(),
          summary: "缺少 Coding Agent Adapter 命令，未执行代码修改",
        }),
      );
    } else {
      const promptPath = path.join(outputDir, "coding-agent-prompt.md");
      await writeFile(
        promptPath,
        renderCodingAgentPrompt({
          input: redactSensitive(options.input),
          repoProfile: options.repoProfile,
          targetStage: intent.targetStage,
        }),
        "utf8",
      );
      const command = formatAdapterCommand(developCommand, {
        promptPath,
        outputDir,
        workspaceRoot: options.workspaceRoot,
      });
      const toolRun = await runCommand({
        command,
        cwd: options.workspaceRoot,
        repoProfile: options.repoProfile,
        outputDir,
        timeoutMs: 600_000,
      });
      developmentRun = toolRun;
      toolRuns.push(toolRun);
      evidence.push(
        await writeTextEvidence({
          workspaceRoot: options.workspaceRoot,
          outputDir,
          type: "document",
          title: "代码变更报告",
          fileName: "development-report.md",
          content: renderDevelopmentReport(toolRun, relativePath(options.workspaceRoot, promptPath)),
          summary: toolRun.status === "passed" ? "开发命令已完成，等待测试验收" : "开发命令未通过或被阻断",
        }),
      );
    }
  }

  const developmentFailed = Boolean(developmentRun && developmentRun.status !== "passed");

  if (shouldRunValidation(intent.targetStage) && !options.dryRun && !developmentFailed && blockedReasons.length === 0) {
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

  const status = computeStatus(intent.targetStage, toolRuns, blockedReasons);
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
      ...blockedReasons.map((reason) => ({
        at: new Date().toISOString(),
        type: "GateTriggered",
        message: reason,
      })),
    ],
  };
  const htmlEvidence = await writeHtmlReport(run, options.workspaceRoot);
  run.evidence.push(htmlEvidence);
  await writeJson(path.join(outputDir, "state.json"), run);
  return run;
}

function shouldRunValidation(targetStage: TargetStage): boolean {
  return targetStage === "development" || targetStage === "validation_report" || targetStage === "pull_request";
}

function shouldRunDevelopment(targetStage: TargetStage): boolean {
  return targetStage === "development" || targetStage === "pull_request";
}

function computeStatus(targetStage: TargetStage, toolRuns: ToolRun[], blockedReasons: string[]): ProjectRun["status"] {
  if (targetStage === "risk_report") {
    return "blocked";
  }
  if (blockedReasons.length > 0) {
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

function renderDevelopmentGap(): string {
  return [
    "# 开发命令缺口",
    "",
    "本次目标阶段需要进入代码修改，但 Repo Profile 未配置 `commands.develop`。",
    "",
    "请在 `.donkey/repo-profile.json` 中配置 Coding Agent Adapter 命令，例如：",
    "",
    "```json",
    '{ "commands": { "develop": "node dist/src/cli.js adapter codex {prompt}", "test": "npm test" } }',
    "```",
    "",
    "也可以运行 `npm start`，选择「3. 配置测试和开发命令」。",
    "",
    "Donkey 不会自动 commit、push 或创建 PR；开发命令完成后会继续运行测试并生成证据包。",
    "",
  ].join("\n");
}

function renderCodingAgentPrompt(options: {
  input: string;
  repoProfile: RepoProfile;
  targetStage: TargetStage;
}): string {
  return [
    "# Donkey Coding Agent Prompt",
    "",
    "你是 Donkey 调用的本地 Coding Agent。请在当前仓库工作区完成代码修改，但不要 commit、push、创建 PR 或执行发布动作。",
    "",
    "## 用户需求",
    "",
    options.input,
    "",
    "## 目标阶段",
    "",
    options.targetStage,
    "",
    "## 仓库验证命令",
    "",
    `- test: ${options.repoProfile.commands.test ?? "未配置"}`,
    `- lint: ${options.repoProfile.commands.lint ?? "未配置"}`,
    `- typecheck: ${options.repoProfile.commands.typecheck ?? "未配置"}`,
    `- e2e: ${options.repoProfile.commands.e2e ?? "未配置"}`,
    "",
    "## 安全边界",
    "",
    "- 不修改生产配置、密钥、token、.env、deploy、infra、migrations 等高危路径。",
    "- 不执行 git push、自动合入、自动上线或生产写操作。",
    "- 改动后保留工作区 diff，由 Donkey 继续执行测试验收并生成报告。",
    "",
  ].join("\n");
}

function formatAdapterCommand(
  template: string,
  paths: { promptPath: string; outputDir: string; workspaceRoot: string },
): string {
  return template
    .replaceAll("{prompt}", relativePath(paths.workspaceRoot, paths.promptPath))
    .replaceAll("{runDir}", relativePath(paths.workspaceRoot, paths.outputDir))
    .replaceAll("{repo}", paths.workspaceRoot);
}

function renderDevelopmentReport(toolRun: ToolRun, promptPath: string): string {
  return [
    "# 代码变更报告",
    "",
    `- Prompt：\`${promptPath}\``,
    `- 命令：\`${toolRun.command}\``,
    `- 状态：${toolRun.status}`,
    `- 退出码：${toolRun.exitCode ?? "无"}`,
    `- stdout：${toolRun.stdoutPath ?? "无"}`,
    `- stderr：${toolRun.stderrPath ?? "无"}`,
    "",
    "Donkey 未执行 commit、push 或 PR 创建。请通过报告和本地 diff 判断是否接受。",
    "",
  ].join("\n");
}

function renderTestReport(toolRun: ToolRun): string {
  return `# 测试报告\n\n- 命令：\`${toolRun.command}\`\n- 状态：${toolRun.status}\n- 退出码：${toolRun.exitCode ?? "无"}\n- stdout：${toolRun.stdoutPath ?? "无"}\n- stderr：${toolRun.stderrPath ?? "无"}\n`;
}
