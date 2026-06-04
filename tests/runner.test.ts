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
  assert.doesNotMatch(html, /开发执行[\s\S]*已执行或已交付[\s\S]*测试验收/);
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
