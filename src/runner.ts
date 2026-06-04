import path from "node:path";
import { chmod, readFile, writeFile } from "node:fs/promises";
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
  let validationRun: ToolRun | undefined;
  let developmentBranch: string | undefined;
  let developmentHead: string | undefined;
  const runnerGitEnv = await createRunnerGitEnv(outputDir);
  const gitGuardEnv = shouldRunValidation(intent.targetStage) && !options.dryRun ? await createGitCommitGuard(outputDir) : undefined;

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
      const gitPreparation = await prepareDevelopmentBranch({
        workspaceRoot: options.workspaceRoot,
        repoProfile: options.repoProfile,
        outputDir,
        runId,
        env: runnerGitEnv,
      });
      toolRuns.push(...gitPreparation.toolRuns);

      if (!gitPreparation.ok) {
        blockedReasons.push(gitPreparation.reason);
        evidence.push(
          await writeTextEvidence({
            workspaceRoot: options.workspaceRoot,
            outputDir,
            type: "document",
            title: "Git 工作区缺口",
            fileName: "git-gap.md",
            content: renderGitGap(gitPreparation.reason, gitPreparation.details),
            summary: gitPreparation.reason,
          }),
        );
      } else {
        developmentBranch = gitPreparation.branchName;
        developmentHead = gitPreparation.head;
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
          env: gitGuardEnv,
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
        const invariant = await assertGitInvariant({
          workspaceRoot: options.workspaceRoot,
          repoProfile: options.repoProfile,
          outputDir,
          expectedBranch: developmentBranch,
          expectedHead: developmentHead,
          env: runnerGitEnv,
        });
        toolRuns.push(...invariant.toolRuns);
        if (!invariant.ok) {
          blockedReasons.push(invariant.reason);
          evidence.push(
            await writeTextEvidence({
              workspaceRoot: options.workspaceRoot,
              outputDir,
              type: "document",
              title: "Git 状态不变量缺口",
              fileName: "git-invariant-gap.md",
              content: renderGitGap(invariant.reason, invariant.details),
              summary: invariant.reason,
            }),
          );
        }
      }
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
        env: gitGuardEnv,
      });
      validationRun = toolRun;
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
      if (developmentBranch && developmentHead) {
        const invariant = await assertGitInvariant({
          workspaceRoot: options.workspaceRoot,
          repoProfile: options.repoProfile,
          outputDir,
          expectedBranch: developmentBranch,
          expectedHead: developmentHead,
          env: runnerGitEnv,
        });
        toolRuns.push(...invariant.toolRuns);
        if (!invariant.ok) {
          blockedReasons.push(invariant.reason);
          evidence.push(
            await writeTextEvidence({
              workspaceRoot: options.workspaceRoot,
              outputDir,
              type: "document",
              title: "Git 状态不变量缺口",
              fileName: "git-invariant-gap.md",
              content: renderGitGap(invariant.reason, invariant.details),
              summary: invariant.reason,
            }),
          );
        }
      }
    } else {
      if (shouldRunDevelopment(intent.targetStage)) {
        blockedReasons.push("Repo Profile 未配置测试命令 commands.test，无法在验证通过后提交代码");
      }
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

  const canCommitDevelopment =
    shouldRunDevelopment(intent.targetStage) &&
    Boolean(developmentBranch) &&
    developmentRun?.status === "passed" &&
    validationRun?.status === "passed" &&
    !toolRuns.some((tool) => tool.status !== "passed") &&
    blockedReasons.length === 0;
  if (canCommitDevelopment) {
    const commitResult = await commitDevelopmentChanges({
      workspaceRoot: options.workspaceRoot,
      repoProfile: options.repoProfile,
      outputDir,
      runId,
      branchName: developmentBranch ?? "",
      expectedHead: developmentHead ?? "",
      env: runnerGitEnv,
    });
    toolRuns.push(...commitResult.toolRuns);
    if (!commitResult.ok) {
      blockedReasons.push(commitResult.reason);
      evidence.push(
        await writeTextEvidence({
          workspaceRoot: options.workspaceRoot,
          outputDir,
          type: "document",
          title: "Git 提交缺口",
          fileName: "git-commit-gap.md",
          content: renderGitGap(commitResult.reason, commitResult.details),
          summary: commitResult.reason,
        }),
      );
    } else {
      evidence.push(
        await writeTextEvidence({
          workspaceRoot: options.workspaceRoot,
          outputDir,
          type: "document",
          title: "Git 分支与提交报告",
          fileName: "git-commit-report.md",
          content: renderGitCommitReport(commitResult.branchName, commitResult.commitMessage, commitResult.changedFiles),
          summary: `已在 ${commitResult.branchName} 创建本地 commit`,
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
    "Donkey 会在开发和测试验收通过后自动创建本地分支与 commit，但不会 push、创建 PR、合入或上线。",
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
    "- 不执行 commit、git push、自动合入、自动上线或生产写操作。",
    "- 改动后保留工作区 diff，由 Donkey 继续执行测试验收、创建本地 commit 并生成报告。",
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
    "Coding Agent 不应执行 commit、push 或 PR 创建；Donkey 会在测试验收后创建本地 commit，并继续禁止 push、PR 和合入。",
    "",
  ].join("\n");
}

function renderTestReport(toolRun: ToolRun): string {
  return `# 测试报告\n\n- 命令：\`${toolRun.command}\`\n- 状态：${toolRun.status}\n- 退出码：${toolRun.exitCode ?? "无"}\n- stdout：${toolRun.stdoutPath ?? "无"}\n- stderr：${toolRun.stderrPath ?? "无"}\n`;
}

async function prepareDevelopmentBranch(options: {
  workspaceRoot: string;
  repoProfile: RepoProfile;
  outputDir: string;
  runId: string;
  env?: Record<string, string>;
}): Promise<
  | { ok: true; branchName: string; head: string; toolRuns: ToolRun[] }
  | { ok: false; reason: string; details: string; toolRuns: ToolRun[] }
> {
  const toolRuns: ToolRun[] = [];
  const statusRun = await runGitCommand("git status --porcelain --untracked-files=all", options);
  toolRuns.push(statusRun);
  if (statusRun.status !== "passed") {
    return {
      ok: false,
      reason: "当前目录不是可用 Git 仓库，无法创建开发分支",
      details: statusRun.reason ?? statusRun.stderrPath ?? "git status failed",
      toolRuns,
    };
  }

  const statusStdout = await readToolStdout(options.workspaceRoot, statusRun);
  const cachedDonkeyPaths = await readStagedDonkeyPaths(options);
  toolRuns.push(...cachedDonkeyPaths.toolRuns);
  if (!cachedDonkeyPaths.ok) {
    return {
      ok: false,
      reason: cachedDonkeyPaths.reason,
      details: cachedDonkeyPaths.details,
      toolRuns,
    };
  }
  if (cachedDonkeyPaths.paths.length > 0) {
    return {
      ok: false,
      reason: "Git 暂存区包含 .donkey 运行产物，无法安全创建开发分支",
      details: cachedDonkeyPaths.paths.join("\n"),
      toolRuns,
    };
  }

  const stagedDonkeyLines = stagedDonkeyGitStatusLines(statusStdout);
  if (stagedDonkeyLines.length > 0) {
    return {
      ok: false,
      reason: "Git 暂存区包含 .donkey 运行产物，无法安全创建开发分支",
      details: stagedDonkeyLines.join("\n"),
      toolRuns,
    };
  }

  const dirtyLines = meaningfulGitStatusLines(statusStdout);
  if (dirtyLines.length > 0) {
    return {
      ok: false,
      reason: "Git 工作区不干净，无法安全创建开发分支",
      details: dirtyLines.join("\n"),
      toolRuns,
    };
  }

  const branchName = `donkey/${options.runId}`;
  const branchRun = await runGitCommand(`git checkout -b ${branchName}`, options);
  toolRuns.push(branchRun);
  if (branchRun.status !== "passed") {
    return {
      ok: false,
      reason: "Git 开发分支创建失败",
      details: branchRun.reason ?? branchRun.stderrPath ?? "git checkout failed",
      toolRuns,
    };
  }

  const stateResult = await readGitState(options);
  toolRuns.push(...stateResult.toolRuns);
  if (!stateResult.ok) {
    return {
      ok: false,
      reason: stateResult.reason,
      details: stateResult.details,
      toolRuns,
    };
  }

  if (stateResult.state.branchName !== branchName) {
    return {
      ok: false,
      reason: "Git 开发分支创建后当前分支不符合预期",
      details: renderGitInvariantDetails({
        expectedBranch: branchName,
        actualBranch: stateResult.state.branchName,
        expectedHead: stateResult.state.head,
        actualHead: stateResult.state.head,
      }),
      toolRuns,
    };
  }

  return { ok: true, branchName, head: stateResult.state.head, toolRuns };
}

async function commitDevelopmentChanges(options: {
  workspaceRoot: string;
  repoProfile: RepoProfile;
  outputDir: string;
  runId: string;
  branchName: string;
  expectedHead: string;
  env?: Record<string, string>;
}): Promise<
  | { ok: true; branchName: string; commitMessage: string; changedFiles: string[]; toolRuns: ToolRun[] }
  | { ok: false; reason: string; details: string; toolRuns: ToolRun[] }
> {
  const toolRuns: ToolRun[] = [];
  const invariant = await assertGitInvariant({
    workspaceRoot: options.workspaceRoot,
    repoProfile: options.repoProfile,
    outputDir: options.outputDir,
    expectedBranch: options.branchName,
    expectedHead: options.expectedHead,
    env: options.env,
  });
  toolRuns.push(...invariant.toolRuns);
  if (!invariant.ok) {
    return {
      ok: false,
      reason: invariant.reason,
      details: invariant.details,
      toolRuns,
    };
  }

  const statusRun = await runGitCommand("git status --porcelain --untracked-files=all", options);
  toolRuns.push(statusRun);
  if (statusRun.status !== "passed") {
    return {
      ok: false,
      reason: "Git 无法读取代码变更状态",
      details: statusRun.reason ?? statusRun.stderrPath ?? "git status failed",
      toolRuns,
    };
  }

  const statusStdout = await readToolStdout(options.workspaceRoot, statusRun);
  const cachedDonkeyPaths = await readStagedDonkeyPaths(options);
  toolRuns.push(...cachedDonkeyPaths.toolRuns);
  if (!cachedDonkeyPaths.ok) {
    return {
      ok: false,
      reason: cachedDonkeyPaths.reason,
      details: cachedDonkeyPaths.details,
      toolRuns,
    };
  }
  if (cachedDonkeyPaths.paths.length > 0) {
    return {
      ok: false,
      reason: "Git 暂存区包含 .donkey 运行产物，无法安全创建本地 commit",
      details: cachedDonkeyPaths.paths.join("\n"),
      toolRuns,
    };
  }

  const stagedDonkeyLines = stagedDonkeyGitStatusLines(statusStdout);
  if (stagedDonkeyLines.length > 0) {
    return {
      ok: false,
      reason: "Git 暂存区包含 .donkey 运行产物，无法安全创建本地 commit",
      details: stagedDonkeyLines.join("\n"),
      toolRuns,
    };
  }

  const changedFiles = meaningfulGitStatusLines(statusStdout);
  if (changedFiles.length === 0) {
    return {
      ok: false,
      reason: "开发命令未产生可提交代码变更",
      details: "git status 为空",
      toolRuns,
    };
  }

  const addRun = await runGitCommand("git add --all -- . :(exclude).donkey", options);
  toolRuns.push(addRun);
  if (addRun.status !== "passed") {
    return {
      ok: false,
      reason: "Git 暂存代码变更失败",
      details: addRun.reason ?? addRun.stderrPath ?? "git add failed",
      toolRuns,
    };
  }

  const commitMessage = `donkey: ${options.runId}`;
  const commitRun = await runGitCommand(`git commit -m ${quoteCommandArg(commitMessage)}`, options);
  toolRuns.push(commitRun);
  if (commitRun.status !== "passed") {
    return {
      ok: false,
      reason: "Git 创建本地 commit 失败",
      details: commitRun.reason ?? commitRun.stderrPath ?? "git commit failed",
      toolRuns,
    };
  }

  return { ok: true, branchName: options.branchName, commitMessage, changedFiles, toolRuns };
}

function runGitCommand(
  command: string,
  options: { workspaceRoot: string; repoProfile: RepoProfile; outputDir: string; env?: Record<string, string> },
): Promise<ToolRun> {
  return runCommand({
    command,
    cwd: options.workspaceRoot,
    repoProfile: options.repoProfile,
    outputDir: options.outputDir,
    env: options.env,
  });
}

async function assertGitInvariant(options: {
  workspaceRoot: string;
  repoProfile: RepoProfile;
  outputDir: string;
  expectedBranch: string;
  expectedHead: string;
  env?: Record<string, string>;
}): Promise<{ ok: true; toolRuns: ToolRun[] } | { ok: false; reason: string; details: string; toolRuns: ToolRun[] }> {
  const stateResult = await readGitState(options);
  if (!stateResult.ok) {
    return stateResult;
  }

  const branchMatches = stateResult.state.branchName === options.expectedBranch;
  const headMatches = stateResult.state.head === options.expectedHead;
  if (branchMatches && headMatches) {
    return { ok: true, toolRuns: stateResult.toolRuns };
  }

  return {
    ok: false,
    reason: "Git 状态已被外部命令改写，Donkey 停止继续提交",
    details: renderGitInvariantDetails({
      expectedBranch: options.expectedBranch,
      actualBranch: stateResult.state.branchName,
      expectedHead: options.expectedHead,
      actualHead: stateResult.state.head,
    }),
    toolRuns: stateResult.toolRuns,
  };
}

async function readGitState(options: {
  workspaceRoot: string;
  repoProfile: RepoProfile;
  outputDir: string;
  env?: Record<string, string>;
}): Promise<
  | { ok: true; state: { branchName: string; head: string }; toolRuns: ToolRun[] }
  | { ok: false; reason: string; details: string; toolRuns: ToolRun[] }
> {
  const toolRuns: ToolRun[] = [];
  const headRun = await runGitCommand("git rev-parse HEAD", options);
  toolRuns.push(headRun);
  if (headRun.status !== "passed") {
    return {
      ok: false,
      reason: "Git 无法读取当前 HEAD",
      details: headRun.reason ?? headRun.stderrPath ?? "git rev-parse failed",
      toolRuns,
    };
  }

  const branchRun = await runGitCommand("git branch --show-current", options);
  toolRuns.push(branchRun);
  if (branchRun.status !== "passed") {
    return {
      ok: false,
      reason: "Git 无法读取当前分支",
      details: branchRun.reason ?? branchRun.stderrPath ?? "git branch failed",
      toolRuns,
    };
  }

  return {
    ok: true,
    state: {
      head: (await readToolStdout(options.workspaceRoot, headRun)).trim(),
      branchName: (await readToolStdout(options.workspaceRoot, branchRun)).trim(),
    },
    toolRuns,
  };
}

async function readStagedDonkeyPaths(options: {
  workspaceRoot: string;
  repoProfile: RepoProfile;
  outputDir: string;
  env?: Record<string, string>;
}): Promise<
  | { ok: true; paths: string[]; toolRuns: ToolRun[] }
  | { ok: false; reason: string; details: string; toolRuns: ToolRun[] }
> {
  const toolRuns: ToolRun[] = [];
  const cachedRun = await runGitCommand("git diff --cached --name-only -z -- .donkey", options);
  toolRuns.push(cachedRun);
  if (cachedRun.status !== "passed") {
    return {
      ok: false,
      reason: "Git 无法读取 .donkey 暂存状态",
      details: cachedRun.reason ?? cachedRun.stderrPath ?? "git diff --cached failed",
      toolRuns,
    };
  }

  return {
    ok: true,
    paths: splitNullSeparated(await readToolStdout(options.workspaceRoot, cachedRun)),
    toolRuns,
  };
}

async function createRunnerGitEnv(outputDir: string): Promise<Record<string, string>> {
  const hooksDir = path.join(outputDir, "runner-git-hooks");
  await ensureDir(hooksDir);

  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooksDir,
  };
}

async function createGitCommitGuard(outputDir: string): Promise<Record<string, string>> {
  const hooksDir = path.join(outputDir, "git-hooks");
  const binDir = path.join(outputDir, "git-bin");
  const execDir = path.join(outputDir, "git-exec");
  await ensureDir(hooksDir);
  await ensureDir(binDir);
  await ensureDir(execDir);

  const hookScript = [
    "#!/bin/sh",
    "echo \"Donkey blocks git writes inside adapter and test commands; Donkey Runner owns local git writes.\" >&2",
    "exit 1",
    "",
  ].join("\n");
  const preCommitPath = path.join(hooksDir, "pre-commit");
  const prePushPath = path.join(hooksDir, "pre-push");
  await writeFile(preCommitPath, hookScript, "utf8");
  await writeFile(prePushPath, hookScript, "utf8");
  await chmod(preCommitPath, 0o755);
  await chmod(prePushPath, 0o755);

  const helperBlockerScript = [
    "#!/bin/sh",
    "echo \"Donkey blocks git push inside adapter and test commands; Donkey Runner never pushes.\" >&2",
    "exit 1",
    "",
  ].join("\n");
  for (const helperName of [
    "git-receive-pack",
    "git-remote-http",
    "git-remote-https",
    "git-remote-ssh",
    "git-remote-ext",
    "git-remote-fd",
  ]) {
    const helperPath = path.join(execDir, helperName);
    await writeFile(helperPath, helperBlockerScript, "utf8");
    await chmod(helperPath, 0o755);
  }

  const gitWrapperPath = path.join(binDir, "git");
  await writeFile(
    gitWrapperPath,
    [
      "#!/bin/sh",
      "find_git_command() {",
      "  while [ \"$#\" -gt 0 ]; do",
      "    case \"$1\" in",
      "      -C|-c|--git-dir|--work-tree|--namespace|--super-prefix|--exec-path|--config-env)",
      "        shift 2 || break",
      "        ;;",
      "      --git-dir=*|--work-tree=*|--namespace=*|--super-prefix=*|--exec-path=*|--config-env=*|-c*)",
      "        shift",
      "        ;;",
      "      --bare|--no-pager|--paginate|--no-replace-objects|--literal-pathspecs|--glob-pathspecs|--noglob-pathspecs|--icase-pathspecs|--no-optional-locks)",
      "        shift",
      "        ;;",
      "      --)",
      "        shift",
      "        break",
      "        ;;",
      "      -*)",
      "        shift",
      "        ;;",
      "      *)",
      "        printf '%s\\n' \"$1\"",
      "        return",
      "        ;;",
      "    esac",
      "  done",
      "}",
      "cmd=\"$(find_git_command \"$@\")\"",
      "case \"$cmd\" in",
      "  commit|push)",
      "    echo \"Donkey blocks git $cmd inside adapter and test commands; Donkey Runner owns local git writes.\" >&2",
      "    exit 1",
      "    ;;",
      "esac",
      "PATH=\"${DONKEY_ORIGINAL_PATH:-$PATH}\"",
      "export PATH",
      "exec git \"$@\"",
      "",
    ].join("\n"),
    "utf8",
  );
  await chmod(gitWrapperPath, 0o755);

  return {
    PATH: [binDir, process.env.PATH ?? ""].filter(Boolean).join(path.delimiter),
    DONKEY_ORIGINAL_PATH: process.env.PATH ?? "",
    GIT_EXEC_PATH: execDir,
    GIT_SSH_COMMAND: "sh -c 'echo Donkey blocks git ssh push inside adapter and test commands >&2; exit 1'",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "core.hooksPath",
    GIT_CONFIG_VALUE_0: hooksDir,
  };
}

async function readToolStdout(workspaceRoot: string, toolRun: ToolRun): Promise<string> {
  if (!toolRun.stdoutPath) {
    return "";
  }
  return readFile(path.join(workspaceRoot, toolRun.stdoutPath), "utf8");
}

function meaningfulGitStatusLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => !gitStatusPaths(line).some(isDonkeyPath));
}

function stagedDonkeyGitStatusLines(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0)
    .filter((line) => isStagedGitStatusLine(line) && gitStatusPaths(line).some(isDonkeyPath));
}

function splitNullSeparated(value: string): string[] {
  return value
    .split("\0")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isStagedGitStatusLine(line: string): boolean {
  const indexStatus = line[0] ?? " ";
  return indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!";
}

function gitStatusPaths(line: string): string[] {
  const rawPath = line.length > 3 ? line.slice(3).trim() : line.trim();
  return rawPath
    .split(" -> ")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function isDonkeyPath(filePath: string): boolean {
  return filePath === ".donkey" || filePath.startsWith(".donkey/");
}

function quoteCommandArg(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function renderGitGap(reason: string, details: string): string {
  return `# Git 工作区缺口\n\n## 结论\n\n${reason}\n\n## 详情\n\n\`\`\`\n${details || "无"}\n\`\`\`\n\nDonkey 未执行 push、PR 创建、合入或上线。\n`;
}

function renderGitInvariantDetails(options: {
  expectedBranch: string;
  actualBranch: string;
  expectedHead: string;
  actualHead: string;
}): string {
  return [
    `expected branch: ${options.expectedBranch}`,
    `actual branch: ${options.actualBranch || "(detached)"}`,
    `expected HEAD: ${options.expectedHead}`,
    `actual HEAD: ${options.actualHead}`,
  ].join("\n");
}

function renderGitCommitReport(branchName: string, commitMessage: string, changedFiles: string[]): string {
  return [
    "# Git 分支与提交报告",
    "",
    `- 分支：\`${branchName}\``,
    `- Commit message：\`${commitMessage}\``,
    "- Push / PR / 合入：未执行",
    "",
    "## 提交文件",
    "",
    changedFiles.map((line) => `- ${line}`).join("\n") || "- 无",
    "",
  ].join("\n");
}
