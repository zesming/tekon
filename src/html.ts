import type { ProjectRun } from "./types.js";
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
        ${stage.skipped ? `已跳过：${escapeHtml(stage.skipReason ?? "")}` : "已执行或已交付"}
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
