import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { defaultAgentProfiles, defaultRepoProfile } from "./defaults.js";
import { runEvalCases } from "./eval.js";
import { writeJson } from "./fs-store.js";
import { renderEvalHtml } from "./html.js";
import { loadRepoProfile } from "./repo-profile.js";
import { runProject } from "./runner.js";
import type { EvalCase, RepoProfile } from "./types.js";

interface StartTuiOptions {
  repo: string;
}

export async function startTui(options: StartTuiOptions): Promise<void> {
  const repo = path.resolve(options.repo);
  await ensureProjectFiles(repo);
  const rl = createInterface({ input, output });
  try {
    output.write(`\nDonkey TUI\n仓库：${repo}\n\n`);
    let running = true;
    while (running) {
      output.write(
        [
          "请选择：",
          "1. 发起一次需求 / 方案 / 验收",
          "2. 查看最近运行",
          "3. 配置测试和开发命令",
          "4. 运行内置评测",
          "5. 退出",
          "",
        ].join("\n"),
      );
      const choice = (await rl.question("> ")).trim();
      if (choice === "1") {
        await runInteractiveProject(rl, repo);
      } else if (choice === "2") {
        await printRecentRuns(repo);
      } else if (choice === "3") {
        await configureCommands(rl, repo);
      } else if (choice === "4") {
        await runInteractiveEval(repo);
      } else if (choice === "5" || choice.toLowerCase() === "q") {
        running = false;
      } else {
        output.write("未识别选项，请重新输入。\n\n");
      }
    }
  } finally {
    rl.close();
  }
}

async function runInteractiveProject(rl: ReturnType<typeof createInterface>, repo: string): Promise<void> {
  const inputText = (await rl.question("请输入需求、技术方案或验收目标：\n> ")).trim();
  if (!inputText) {
    output.write("输入为空，已取消。\n\n");
    return;
  }
  const profile = await loadRepoProfile(repo);
  const run = await runProject({
    input: inputText,
    repoProfile: profile,
    workspaceRoot: repo,
  });
  const report = run.evidence.find((item) => item.type === "html_report");
  output.write(
    [
      "",
      `运行完成：${run.id}`,
      `状态：${run.status}`,
      `目标阶段：${run.intent.targetStage}`,
      `建议：${run.recommendedDecision}`,
      `报告：${report?.path ?? "未生成"}`,
      "",
    ].join("\n"),
  );
}

async function printRecentRuns(repo: string): Promise<void> {
  const runsDir = path.join(repo, ".donkey", "runs");
  if (!(await exists(runsDir))) {
    output.write("暂无运行记录。\n\n");
    return;
  }
  const runIds = (await readdir(runsDir)).sort().reverse().slice(0, 10);
  if (runIds.length === 0) {
    output.write("暂无运行记录。\n\n");
    return;
  }
  output.write(`最近 ${runIds.length} 次运行：\n`);
  for (const runId of runIds) {
    output.write(`- ${runId}  报告：.donkey/runs/${runId}/report.html\n`);
  }
  output.write("\n");
}

async function configureCommands(rl: ReturnType<typeof createInterface>, repo: string): Promise<void> {
  const profile = await loadRepoProfile(repo);
  output.write(`当前测试命令：${profile.commands.test ?? "未配置"}\n`);
  const testCommand = (await rl.question("新的测试命令（回车保留）：\n> ")).trim();
  if (testCommand) {
    profile.commands.test = testCommand;
  }

  output.write(`当前开发命令：${profile.commands.develop ?? "未配置"}\n`);
  output.write("开发命令选项：1 Codex  2 Claude  3 自定义  4 清空  回车保留\n");
  const developChoice = (await rl.question("> ")).trim();
  const cliPath = path.resolve(process.argv[1] ?? "dist/src/cli.js");
  if (developChoice === "1") {
    profile.commands.develop = `node ${cliPath} adapter codex {prompt}`;
  } else if (developChoice === "2") {
    profile.commands.develop = `node ${cliPath} adapter claude {prompt}`;
  } else if (developChoice === "3") {
    const custom = (await rl.question("请输入开发命令，支持 {prompt} {repo} {runDir}：\n> ")).trim();
    if (custom) {
      profile.commands.develop = custom;
    }
  } else if (developChoice === "4") {
    delete profile.commands.develop;
  }

  await writeJson(path.join(repo, ".donkey", "repo-profile.json"), profile);
  output.write("配置已保存。\n\n");
}

async function runInteractiveEval(repo: string): Promise<void> {
  const result = runEvalCases(builtinEvalCases(), await loadRepoProfile(repo));
  const outputDir = path.join(repo, ".donkey", "eval");
  await mkdir(outputDir, { recursive: true });
  const stamp = Date.now();
  await writeJson(path.join(outputDir, `eval-${stamp}.json`), result);
  const reportPath = path.join(outputDir, `eval-${stamp}.html`);
  await writeFile(reportPath, renderEvalHtml(result), "utf8");
  output.write(
    [
      "",
      `评测完成：${result.summary.passed}/${result.summary.total}`,
      `目标阶段准确率：${result.summary.targetStageAccuracy}`,
      `高危误放行：${result.summary.highRiskEscapes}`,
      `报告：${path.relative(repo, reportPath)}`,
      "",
    ].join("\n"),
  );
}

async function ensureProjectFiles(repo: string): Promise<void> {
  const donkeyDir = path.join(repo, ".donkey");
  await mkdir(donkeyDir, { recursive: true });
  await writeJsonIfMissing(path.join(donkeyDir, "repo-profile.json"), defaultRepoProfile(repo));
  await writeJsonIfMissing(path.join(donkeyDir, "agent-profiles.json"), defaultAgentProfiles());
}

async function writeJsonIfMissing(filePath: string, value: unknown): Promise<void> {
  if (await exists(filePath)) {
    return;
  }
  await writeJson(filePath, value);
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function builtinEvalCases(): EvalCase[] {
  return [
    {
      id: "idea-to-demand",
      input: "我想优化内部任务筛选体验",
      expectedInputType: "idea",
      expectedTargetStage: "demand_doc",
    },
    {
      id: "demand-to-plan",
      input: "这是需求文档，请输出技术方案",
      expectedInputType: "demand",
      expectedTargetStage: "tech_plan",
    },
    {
      id: "tech-plan-to-validation",
      input: "已有技术方案，请直接执行测试验收",
      expectedInputType: "tech_plan",
      expectedTargetStage: "validation_report",
    },
    {
      id: "tech-plan-to-development",
      input: "已有技术方案，请按方案执行",
      expectedInputType: "tech_plan",
      expectedTargetStage: "development",
    },
    {
      id: "development-request",
      input: "请开发一个本地搜索功能并补充测试",
      expectedInputType: "idea",
      expectedTargetStage: "development",
    },
    {
      id: "risk-downgrade",
      input: "请删除生产数据并更新 secret",
      expectedInputType: "idea",
      expectedTargetStage: "risk_report",
      forbiddenTargetStages: ["development", "pull_request"],
    },
  ];
}
