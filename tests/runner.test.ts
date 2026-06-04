import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runProject } from "../src/runner.js";
import { defaultRepoProfile } from "../src/defaults.js";

test("runs a local validation workflow and writes evidence package", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-runner-"));
  await writeFile(path.join(root, "sample.test.js"), "import test from 'node:test'; test('ok', () => {});\n");
  const profile = defaultRepoProfile(root);
  profile.commands.test = "node --test sample.test.js";

  const result = await runProject({
    input: "已有技术方案，请直接执行测试验收",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.intent.targetStage, "validation_report");
  assert.equal(result.toolRuns.length, 1);
  assert.equal(result.toolRuns[0]?.status, "passed");

  const report = result.evidence.find((item) => item.type === "html_report");
  assert.ok(report);
  const html = await readFile(path.join(root, report.path), "utf8");
  assert.match(html, /Donkey 交付证据包/);
  assert.match(html, /HTML 交付证据包/);
  assert.match(html, /开发执行[\s\S]*已跳过/);
  assert.match(html, /测试验收[\s\S]*已执行：测试命令通过/);
  assert.doesNotMatch(html, /开发执行[\s\S]*已执行：开发命令/);
});

test("does not execute commands when target is risk report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-risk-"));
  const profile = defaultRepoProfile(root);
  profile.commands.test = "node --test";

  const result = await runProject({
    input: "请修改生产发布链路并更新 secret",
    repoProfile: profile,
    requestedTargetStage: "pull_request",
    workspaceRoot: root,
  });

  assert.equal(result.intent.targetStage, "risk_report");
  assert.equal(result.toolRuns.length, 0);
  assert.equal(result.recommendedDecision, "blocked");
});

test("runs configured development adapter before validation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-develop-"));
  await writeFile(
    path.join(root, "dev-agent.mjs"),
    [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const prompt = readFileSync(process.argv[2], 'utf8');",
      "if (!prompt.includes('Donkey Coding Agent Prompt')) process.exit(2);",
      "writeFileSync('feature.txt', 'done\\n');",
      "",
    ].join("\n"),
  );
  await writeFile(
    path.join(root, "feature.test.js"),
    [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { readFileSync } from 'node:fs';",
      "test('feature exists', () => {",
      "  assert.equal(readFileSync('feature.txt', 'utf8'), 'done\\n');",
      "});",
      "",
    ].join("\n"),
  );
  const profile = defaultRepoProfile(root);
  profile.commands.test = "node --test feature.test.js";
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.risk.allowedCommandPatterns = [
    "^node\\s+dev-agent\\.mjs\\s+.*$",
    "^node\\s+--test\\s+feature\\.test\\.js$",
  ];

  const result = await runProject({
    input: "请开发 feature.txt 并补充测试",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "completed");
  assert.equal(result.intent.targetStage, "development");
  assert.equal(result.toolRuns.length, 2);
  assert.match(result.toolRuns[0]?.command ?? "", /dev-agent/);
  assert.match(result.toolRuns[1]?.command ?? "", /feature\.test/);
  assert.equal(await readFile(path.join(root, "feature.txt"), "utf8"), "done\n");
  assert.ok(result.evidence.some((item) => item.title === "代码变更报告"));

  const implementationStage = result.workflow.stages.find((stage) => stage.id === "implementation");
  const validationStage = result.workflow.stages.find((stage) => stage.id === "validation");
  assert.equal(implementationStage?.skipped, false);
  assert.equal(validationStage?.skipped, false);

  const report = result.evidence.find((item) => item.type === "html_report");
  assert.ok(report);
  const html = await readFile(path.join(root, report.path), "utf8");
  assert.match(html, /开发执行[\s\S]*已执行：开发命令通过/);
  assert.match(html, /测试验收[\s\S]*已执行：测试命令通过/);
});

test("marks development and validation stages accurately when development command is missing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-develop-gap-"));
  const profile = defaultRepoProfile(root);
  delete profile.commands.develop;
  profile.commands.test = "node --test";

  const result = await runProject({
    input: "已有技术方案，请按方案执行",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.intent.targetStage, "development");
  assert.equal(result.toolRuns.length, 0);
  assert.ok(result.evidence.some((item) => item.title === "开发命令缺口"));

  const report = result.evidence.find((item) => item.type === "html_report");
  assert.ok(report);
  const html = await readFile(path.join(root, report.path), "utf8");
  assert.match(html, /开发执行[\s\S]*已阻断：缺少开发命令 commands\.develop/);
  assert.match(html, /测试验收[\s\S]*未执行：开发阶段未通过或被阻断/);
  assert.doesNotMatch(html, /开发执行[\s\S]*已执行：开发命令/);
});

test("redacts sensitive input and command values from persisted evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-redact-"));
  await writeFile(
    path.join(root, "leak.test.js"),
    "console.log('OPENAI_API_KEY sk-from-log password: from-log --token from-log');\n",
  );
  const profile = defaultRepoProfile(root);
  profile.commands.test = "node leak.test.js --token abc123";
  profile.risk.highRiskKeywords = [];
  profile.risk.allowedCommandPatterns = ["^node\\s+leak\\.test\\.js\\s+--token\\s+.*$"];

  const result = await runProject({
    input: "已有技术方案，请直接执行测试验收 SECRET=super-secret password: input-pass OPENAI_API_KEY sk-input",
    repoProfile: profile,
    workspaceRoot: root,
  });

  const statePath = path.join(root, ".donkey", "runs", result.id, "state.json");
  const reportPath = path.join(root, ".donkey", "runs", result.id, "report.html");
  const stdoutPath = path.join(root, result.toolRuns[0]?.stdoutPath ?? "");
  const persisted = [
    JSON.stringify(result),
    await readFile(statePath, "utf8"),
    await readFile(reportPath, "utf8"),
    await readFile(stdoutPath, "utf8"),
  ].join("\n");

  assert.doesNotMatch(persisted, /super-secret|abc123|from-log|input-pass|sk-input|sk-from-log/);
  assert.match(persisted, /REDACTED/);
});
