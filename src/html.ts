import type { ProjectRun, ToolRun, WorkflowStage } from "./types.js";
import type { EvalRunResult } from "./eval.js";
import { redactSensitive } from "./redact.js";

export function renderEvidenceHtml(run: ProjectRun): string {
  const toolRows = run.toolRuns
    .map(
      (tool) => `<tr>
        <td>${escapeHtml(tool.id)}</td>
        <td><code>${escapeHtml(redactSensitive(tool.command))}</code></td>
        <td>${escapeHtml(tool.status)}</td>
        <td>${tool.exitCode ?? ""}</td>
        <td>${tool.durationMs}</td>
      </tr>`,
    )
    .join("");
  const evidenceRows = run.evidence
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.type)}</td>
        <td>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(item.summary)}</td>
        <td><code>${escapeHtml(item.path)}</code></td>
      </tr>`,
    )
    .join("");
  const stages = run.workflow.stages
    .map(
      (stage) => `<li>
        <strong>${escapeHtml(stage.title)}</strong>
        ${escapeHtml(stageStatus(run, stage))}
      </li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Donkey 交付证据包 ${escapeHtml(run.id)}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.65; color: #172033; margin: 40px auto; max-width: 1100px; padding: 0 24px; }
    h1 { border-bottom: 2px solid #e6e8ef; padding-bottom: 12px; }
    h2 { margin-top: 32px; border-left: 4px solid #2457e6; padding-left: 10px; }
    table { width: 100%; border-collapse: collapse; margin: 14px 0 24px; }
    th, td { border: 1px solid #dfe5f2; padding: 8px 10px; vertical-align: top; }
    th { background: #f7f9fd; text-align: left; }
    code { background: #eef2f8; padding: 1px 5px; border-radius: 4px; }
    .status { padding: 12px 14px; border-radius: 8px; background: #f7f9fd; border: 1px solid #dfe5f2; }
  </style>
</head>
<body>
  <h1>Donkey 交付证据包</h1>
  <p class="status"><strong>Run：</strong>${escapeHtml(run.id)}；<strong>状态：</strong>${escapeHtml(run.status)}；<strong>建议：</strong>${escapeHtml(run.recommendedDecision)}</p>
  <h2>输入与目标</h2>
  <p>${escapeHtml(redactSensitive(run.input))}</p>
  <table>
    <tr><th>输入类型</th><td>${escapeHtml(run.intent.inputType)}</td></tr>
    <tr><th>目标阶段</th><td>${escapeHtml(run.intent.targetStage)}</td></tr>
    <tr><th>风险等级</th><td>${escapeHtml(run.intent.riskLevel)}</td></tr>
    <tr><th>判断依据</th><td>${run.intent.reasons.map(escapeHtml).join("<br>")}</td></tr>
    <tr><th>信息缺口</th><td>${run.intent.missingInfo.map(escapeHtml).join("<br>") || "无"}</td></tr>
  </table>
  <h2>Workflow 阶段</h2>
  <ul>${stages}</ul>
  <h2>工具执行</h2>
  <table>
    <thead><tr><th>ID</th><th>命令</th><th>状态</th><th>退出码</th><th>耗时 ms</th></tr></thead>
    <tbody>${toolRows || "<tr><td colspan=\"5\">无工具执行</td></tr>"}</tbody>
  </table>
  <h2>证据</h2>
  <table>
    <thead><tr><th>类型</th><th>标题</th><th>摘要</th><th>路径</th></tr></thead>
    <tbody>${evidenceRows}</tbody>
  </table>
</body>
</html>
`;
}

function stageStatus(run: ProjectRun, stage: WorkflowStage): string {
  if (stage.skipped) {
    return `已跳过：${stage.skipReason ?? ""}`;
  }

  if (stage.id === "implementation") {
    return implementationStageStatus(run);
  }

  if (stage.id === "validation") {
    return validationStageStatus(run);
  }

  if (stage.id === "evidence_package") {
    return hasEvidence(run, "HTML 交付证据包") ? "已交付：HTML 证据包已生成" : "计划交付：等待证据包生成";
  }

  return "已交付：文档或报告已生成";
}

function implementationStageStatus(run: ProjectRun): string {
  if (!requiresDevelopment(run)) {
    return "未执行：目标阶段不需要代码修改";
  }

  if (hasEvidence(run, "开发命令缺口")) {
    return "已阻断：缺少开发命令 commands.develop";
  }

  if (hasEvidence(run, "Git 工作区缺口")) {
    return "已阻断：Git 工作区未满足开发前置条件";
  }

  if (hasEvidence(run, "Git 状态不变量缺口")) {
    return "已阻断：Git 状态被外部命令改写";
  }

  const tool = developmentToolRun(run);
  if (!tool) {
    return run.status === "blocked" ? "已阻断：开发命令未执行" : "未执行：未记录开发命令";
  }

  return toolStatus("开发命令", tool);
}

function validationStageStatus(run: ProjectRun): string {
  const tool = validationToolRun(run);
  if (tool) {
    return toolStatus("测试命令", tool);
  }

  if (hasEvidence(run, "测试缺口")) {
    return "已交付缺口：未配置测试命令";
  }

  if (requiresDevelopment(run)) {
    return "未执行：开发阶段未通过或被阻断";
  }

  return run.status === "blocked" ? "未执行：运行已阻断" : "未执行：未记录测试命令";
}

function toolStatus(label: string, tool: ToolRun): string {
  if (tool.status === "passed") {
    return `已执行：${label}通过`;
  }

  if (tool.status === "failed") {
    return `已失败：${label}退出码 ${tool.exitCode ?? "无"}`;
  }

  return `已阻断：${tool.reason ?? `${label}被策略拦截`}`;
}

function requiresDevelopment(run: ProjectRun): boolean {
  return run.intent.targetStage === "development" || run.intent.targetStage === "pull_request";
}

function developmentToolRun(run: ProjectRun): ToolRun | undefined {
  if (!requiresDevelopment(run)) {
    return undefined;
  }

  return run.toolRuns.find((tool) => !isDonkeyInternalGitCommand(tool.command));
}

function validationToolRun(run: ProjectRun): ToolRun | undefined {
  if (!hasEvidence(run, "测试报告")) {
    return undefined;
  }

  if (requiresDevelopment(run)) {
    const developmentTool = developmentToolRun(run);
    const developmentIndex = developmentTool ? run.toolRuns.indexOf(developmentTool) : -1;
    return run.toolRuns.find(
      (tool, index) =>
        index > developmentIndex && tool.id !== developmentTool?.id && !isDonkeyInternalGitCommand(tool.command),
    );
  }

  return run.toolRuns[0];
}

function isDonkeyInternalGitCommand(command: string): boolean {
  return (
    command === "git status --porcelain --untracked-files=all" ||
    command === "git rev-parse HEAD" ||
    command === "git branch --show-current" ||
    command === "git diff --cached --name-only -z -- .donkey" ||
    command === "git add --all -- . :(exclude).donkey" ||
    /^git checkout -b donkey\/run-[0-9T-]+Z$/.test(command) ||
    /^git commit -m "donkey: run-[0-9T-]+Z"$/.test(command)
  );
}

function hasEvidence(run: ProjectRun, title: string): boolean {
  return run.evidence.some((item) => item.title === title);
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderEvalHtml(result: EvalRunResult): string {
  const rows = result.results
    .map(
      (item) => `<tr>
        <td>${escapeHtml(item.id)}</td>
        <td>${item.passed ? "通过" : "失败"}</td>
        <td>${escapeHtml(item.expectedInputType)} / ${escapeHtml(item.actualInputType)}</td>
        <td>${escapeHtml(item.expectedTargetStage)} / ${escapeHtml(item.actualTargetStage)}</td>
        <td>${item.reasons.map(escapeHtml).join("<br>")}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Donkey Eval 评测报告</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; line-height: 1.65; color: #172033; margin: 40px auto; max-width: 1100px; padding: 0 24px; }
    h1 { border-bottom: 2px solid #e6e8ef; padding-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; margin: 14px 0 24px; }
    th, td { border: 1px solid #dfe5f2; padding: 8px 10px; vertical-align: top; }
    th { background: #f7f9fd; text-align: left; }
    .summary { padding: 12px 14px; border-radius: 8px; background: #f7f9fd; border: 1px solid #dfe5f2; }
  </style>
</head>
<body>
  <h1>Donkey Eval 评测报告</h1>
  <p class="summary">总数：${result.summary.total}；通过：${result.summary.passed}；失败：${result.summary.failed}；通过率：${Math.round(result.summary.passRate * 100)}%；输入类型准确率：${Math.round(result.summary.inputTypeAccuracy * 100)}%；目标阶段准确率：${Math.round(result.summary.targetStageAccuracy * 100)}%；高危误放行：${result.summary.highRiskEscapes}</p>
  <table>
    <thead><tr><th>Case</th><th>结果</th><th>输入类型 期望/实际</th><th>目标阶段 期望/实际</th><th>判断依据</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</body>
</html>
`;
}
