import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
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

test("runs configured development adapter on a new branch and commits after validation", async () => {
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
  initGitRepo(root);

  const profile = defaultRepoProfile(root);
  profile.commands.test = "node --test feature.test.js";
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.risk.allowedCommandPatterns = [
    ...profile.risk.allowedCommandPatterns,
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
  assert.ok(result.toolRuns.some((tool) => /git checkout -b donkey\//.test(tool.command)));
  assert.ok(result.toolRuns.some((tool) => /dev-agent/.test(tool.command)));
  assert.ok(result.toolRuns.some((tool) => /feature\.test/.test(tool.command)));
  assert.ok(result.toolRuns.some((tool) => /git commit -m/.test(tool.command)));
  assert.equal(await readFile(path.join(root, "feature.txt"), "utf8"), "done\n");
  assert.ok(result.evidence.some((item) => item.title === "代码变更报告"));
  assert.ok(result.evidence.some((item) => item.title === "Git 分支与提交报告"));

  const branch = git(root, ["branch", "--show-current"]).stdout.trim();
  const commitSubject = git(root, ["log", "-1", "--pretty=%s"]).stdout.trim();
  assert.match(branch, /^donkey\/run-/);
  assert.match(commitSubject, /^donkey: /);
  assert.equal(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout.includes(".donkey/"), false);

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

test("does not commit development changes when no validation command is configured", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-no-test-"));
  await writeFile(
    path.join(root, "dev-agent.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync('feature.txt', 'done\\n');\n",
  );
  initGitRepo(root);

  const profile = defaultRepoProfile(root);
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  delete profile.commands.test;
  profile.risk.allowedCommandPatterns = [
    ...profile.risk.allowedCommandPatterns,
    "^node\\s+dev-agent\\.mjs\\s+.*$",
  ];

  const initialHead = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const result = await runProject({
    input: "请开发 feature.txt",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "blocked");
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout.trim(), initialHead);
  assert.ok(await exists(path.join(root, "feature.txt")));
  assert.equal(result.toolRuns.some((tool) => /git commit -m/.test(tool.command)), false);
  assert.ok(result.evidence.some((item) => item.title === "测试缺口"));
});

test("does not commit development changes when validation fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-failing-test-"));
  await writeFile(
    path.join(root, "dev-agent.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync('feature.txt', 'done\\n');\n",
  );
  await writeFile(path.join(root, "feature.test.js"), "process.exit(1);\n");
  initGitRepo(root);

  const profile = defaultRepoProfile(root);
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.commands.test = "node feature.test.js";
  profile.risk.allowedCommandPatterns = [
    ...profile.risk.allowedCommandPatterns,
    "^node\\s+dev-agent\\.mjs\\s+.*$",
    "^node\\s+feature\\.test\\.js$",
  ];

  const initialHead = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const result = await runProject({
    input: "请开发 feature.txt 并补充测试",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "failed");
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout.trim(), initialHead);
  assert.ok(await exists(path.join(root, "feature.txt")));
  assert.equal(result.toolRuns.some((tool) => /git commit -m/.test(tool.command)), false);
  assert.ok(result.evidence.some((item) => item.title === "测试报告"));

  const report = result.evidence.find((item) => item.type === "html_report");
  assert.ok(report);
  const html = await readFile(path.join(root, report.path), "utf8");
  assert.match(html, /开发执行[\s\S]*已执行：开发命令通过/);
  assert.match(html, /测试验收[\s\S]*已失败：测试命令退出码 1/);
  assert.doesNotMatch(html, /测试验收[\s\S]*已执行：测试命令通过/);
});

test("prevents adapter-owned commits when validation fails", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-rogue-commit-"));
  await writeFile(
    path.join(root, "dev-agent.mjs"),
    [
      "import { writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "writeFileSync('feature.txt', 'done\\n');",
      "spawnSync('git', ['add', 'feature.txt']);",
      "spawnSync('git', ['commit', '-m', 'rogue adapter commit']);",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, "feature.test.js"), "process.exit(1);\n");
  initGitRepo(root);

  const profile = defaultRepoProfile(root);
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.commands.test = "node feature.test.js";
  profile.risk.allowedCommandPatterns = [
    ...profile.risk.allowedCommandPatterns,
    "^node\\s+dev-agent\\.mjs\\s+.*$",
    "^node\\s+feature\\.test\\.js$",
  ];

  const initialHead = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const result = await runProject({
    input: "请开发 feature.txt 并补充测试",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "failed");
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout.trim(), initialHead);
  assert.equal(git(root, ["log", "-1", "--pretty=%s"]).stdout.trim(), "initial");
  assert.equal(result.toolRuns.some((tool) => /git commit -m/.test(tool.command)), false);
  assert.ok(result.evidence.some((item) => item.title === "测试报告"));
});

test("blocks development when adapter bypasses commit guard and moves head", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-rogue-no-verify-"));
  const gitPath = realGitPath();
  await writeFile(
    path.join(root, "dev-agent.mjs"),
    [
      "import { writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      `const git = ${JSON.stringify(gitPath)};`,
      "writeFileSync('feature.txt', 'done\\n');",
      "spawnSync(git, ['add', 'feature.txt']);",
      "const result = spawnSync(git, ['commit', '--no-verify', '-m', 'rogue adapter commit']);",
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(root, "feature.test.js"), "process.exit(0);\n");
  initGitRepo(root);

  const profile = defaultRepoProfile(root);
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.commands.test = "node feature.test.js";
  profile.risk.allowedCommandPatterns = [
    ...profile.risk.allowedCommandPatterns,
    "^node\\s+dev-agent\\.mjs\\s+.*$",
    "^node\\s+feature\\.test\\.js$",
  ];

  const result = await runProject({
    input: "请开发 feature.txt 并补充测试",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "blocked");
  assert.equal(git(root, ["log", "-1", "--pretty=%s"]).stdout.trim(), "rogue adapter commit");
  assert.equal(result.toolRuns.some((tool) => /node feature\.test\.js/.test(tool.command)), false);
  assert.equal(result.toolRuns.some((tool) => /git commit -m/.test(tool.command)), false);
  assert.ok(result.evidence.some((item) => item.title === "Git 状态不变量缺口"));
});

test("prevents adapter-owned pushes", async () => {
  await assertAdapterPushBlocked("git", ["push", "--no-verify", "origin", "HEAD:refs/heads/rogue"]);
});

test("prevents adapter-owned pushes with git global options", async () => {
  await assertAdapterPushBlocked("git", ["-C", ".", "push", "--no-verify", "origin", "HEAD:refs/heads/rogue"]);
  await assertAdapterPushBlocked("git", [
    "-c",
    "core.hooksPath=/dev/null",
    "push",
    "--no-verify",
    "origin",
    "HEAD:refs/heads/rogue",
  ]);
});

test("prevents adapter-owned pushes through absolute git path", async () => {
  await assertAdapterPushBlocked(realGitPath(), ["-C", ".", "push", "--no-verify", "origin", "HEAD:refs/heads/rogue"]);
});

test("prevents runner-owned branch and commit hooks from pushing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-runner-hook-push-"));
  const remote = await mkdtemp(path.join(tmpdir(), "donkey-remote-"));
  await writeFile(
    path.join(root, "dev-agent.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync('feature.txt', 'done\\n');\n",
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
  initGitRepo(root);
  initBareGitRepo(remote);
  git(root, ["remote", "add", "origin", remote]);
  await writeFile(
    path.join(root, ".git", "hooks", "post-checkout"),
    ["#!/bin/sh", "git push --no-verify origin HEAD:refs/heads/post-checkout-rogue >/dev/null 2>&1", ""].join("\n"),
  );
  await writeFile(
    path.join(root, ".git", "hooks", "post-commit"),
    ["#!/bin/sh", "git push --no-verify origin HEAD:refs/heads/post-commit-rogue >/dev/null 2>&1", ""].join("\n"),
  );
  chmodHook(root, "post-checkout");
  chmodHook(root, "post-commit");

  const profile = defaultRepoProfile(root);
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.commands.test = "node --test feature.test.js";
  profile.risk.allowedCommandPatterns = [
    ...profile.risk.allowedCommandPatterns,
    "^node\\s+dev-agent\\.mjs\\s+.*$",
    "^node\\s+--test\\s+feature\\.test\\.js$",
  ];

  const result = await runProject({
    input: "请开发 feature.txt 并补充测试",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "completed");
  assert.equal(remoteRefExists(remote, "refs/heads/post-checkout-rogue"), false);
  assert.equal(remoteRefExists(remote, "refs/heads/post-commit-rogue"), false);
  assert.ok(result.toolRuns.some((tool) => /git commit -m/.test(tool.command)));
});

test("prevents validation-only test commands from committing and pushing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-validation-rogue-git-"));
  const remote = await mkdtemp(path.join(tmpdir(), "donkey-remote-"));
  await writeFile(
    path.join(root, "check.mjs"),
    [
      "import { writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "writeFileSync('validation-rogue.txt', 'change\\n');",
      "spawnSync('git', ['add', 'validation-rogue.txt']);",
      "spawnSync('git', ['commit', '-m', 'validation rogue commit']);",
      "spawnSync('git', ['-C', '.', 'push', '--no-verify', 'origin', 'HEAD:refs/heads/validation-rogue']);",
      "process.exit(0);",
      "",
    ].join("\n"),
  );
  initGitRepo(root);
  initBareGitRepo(remote);
  git(root, ["remote", "add", "origin", remote]);

  const profile = defaultRepoProfile(root);
  profile.commands.test = "node check.mjs";
  profile.risk.allowedCommandPatterns = [...profile.risk.allowedCommandPatterns, "^node\\s+check\\.mjs$"];
  const initialHead = git(root, ["rev-parse", "HEAD"]).stdout.trim();

  const result = await runProject({
    input: "已有技术方案，请直接执行测试验收",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "completed");
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout.trim(), initialHead);
  assert.equal(remoteRefExists(remote, "refs/heads/validation-rogue"), false);
  assert.equal(result.toolRuns.some((tool) => /git commit -m/.test(tool.command)), false);
});

test("renders validation stage from actual custom test command", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-custom-test-"));
  await writeFile(path.join(root, "check.mjs"), "process.exit(0);\n");
  const profile = defaultRepoProfile(root);
  profile.commands.test = "node check.mjs";
  profile.risk.allowedCommandPatterns = ["^node\\s+check\\.mjs$"];

  const result = await runProject({
    input: "已有技术方案，请直接执行测试验收",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "completed");
  const report = result.evidence.find((item) => item.type === "html_report");
  assert.ok(report);
  const html = await readFile(path.join(root, report.path), "utf8");
  assert.match(html, /测试验收[\s\S]*已执行：测试命令通过/);
});

test("renders validation stage from git-based test command", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-git-test-"));
  await writeFile(path.join(root, "README.md"), "# fixture\n");
  initGitRepo(root);
  const profile = defaultRepoProfile(root);
  profile.commands.test = "git diff --check";
  profile.risk.allowedCommandPatterns = [...profile.risk.allowedCommandPatterns, "^git\\s+diff\\s+--check$"];

  const result = await runProject({
    input: "已有技术方案，请直接执行测试验收",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "completed");
  const report = result.evidence.find((item) => item.type === "html_report");
  assert.ok(report);
  const html = await readFile(path.join(root, report.path), "utf8");
  assert.match(html, /测试验收[\s\S]*已执行：测试命令通过/);
});

test("blocks development when git workspace is dirty before branch creation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-dirty-"));
  await writeFile(path.join(root, "dev-agent.mjs"), "process.exit(0);\n");
  initGitRepo(root);
  await writeFile(path.join(root, "dirty.txt"), "user change\n");

  const profile = defaultRepoProfile(root);
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.risk.allowedCommandPatterns = [
    ...profile.risk.allowedCommandPatterns,
    "^node\\s+dev-agent\\.mjs\\s+.*$",
  ];

  const result = await runProject({
    input: "请开发 feature.txt 并补充测试",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.toolRuns.some((tool) => /dev-agent/.test(tool.command)), false);
  assert.ok(result.evidence.some((item) => item.title === "Git 工作区缺口"));
});

test("blocks development when donkey artifacts are already staged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-staged-artifact-"));
  await writeFile(
    path.join(root, "dev-agent.mjs"),
    "import { writeFileSync } from 'node:fs'; writeFileSync('feature.txt', 'done\\n');\n",
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
  initGitRepo(root);
  await mkdir(path.join(root, ".donkey"), { recursive: true });
  await writeFile(path.join(root, ".donkey", "prestaged.txt"), "artifact\n");
  git(root, ["add", ".donkey/prestaged.txt"]);

  const profile = defaultRepoProfile(root);
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.commands.test = "node --test feature.test.js";
  profile.risk.allowedCommandPatterns = [
    ...profile.risk.allowedCommandPatterns,
    "^node\\s+dev-agent\\.mjs\\s+.*$",
    "^node\\s+--test\\s+feature\\.test\\.js$",
  ];

  const result = await runProject({
    input: "请开发 feature.txt 并补充测试",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.toolRuns.some((tool) => /dev-agent/.test(tool.command)), false);
  assert.ok(result.evidence.some((item) => item.title === "Git 工作区缺口"));
  assert.equal(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout.includes(".donkey/"), false);
});

test("blocks commit when adapter stages donkey artifact with a quoted path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-staged-quoted-artifact-"));
  await mkdir(path.join(root, ".donkey"), { recursive: true });
  await writeFile(
    path.join(root, "dev-agent.mjs"),
    [
      "import { mkdirSync, writeFileSync } from 'node:fs';",
      "import { spawnSync } from 'node:child_process';",
      "writeFileSync('feature.txt', 'done\\n');",
      "mkdirSync('.donkey', { recursive: true });",
      "writeFileSync('.donkey/a b.txt', 'artifact\\n');",
      "spawnSync('git', ['add', '.donkey/a b.txt']);",
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
  initGitRepo(root);

  const profile = defaultRepoProfile(root);
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.commands.test = "node --test feature.test.js";
  profile.risk.allowedCommandPatterns = [
    ...profile.risk.allowedCommandPatterns,
    "^node\\s+dev-agent\\.mjs\\s+.*$",
    "^node\\s+--test\\s+feature\\.test\\.js$",
  ];

  const initialHead = git(root, ["rev-parse", "HEAD"]).stdout.trim();
  const result = await runProject({
    input: "请开发 feature.txt 并补充测试",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(result.status, "blocked");
  assert.equal(git(root, ["rev-parse", "HEAD"]).stdout.trim(), initialHead);
  assert.equal(result.toolRuns.some((tool) => /git commit -m/.test(tool.command)), false);
  assert.equal(git(root, ["ls-tree", "-r", "--name-only", "HEAD"]).stdout.includes(".donkey/"), false);
  assert.ok(result.evidence.some((item) => item.title === "Git 提交缺口"));
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

function initGitRepo(root: string): void {
  git(root, ["init"]);
  git(root, ["config", "user.name", "Donkey Test"]);
  git(root, ["config", "user.email", "donkey@example.com"]);
  git(root, ["add", "--all"]);
  git(root, ["commit", "-m", "initial"]);
}

function initBareGitRepo(root: string): void {
  git(root, ["init", "--bare"]);
}

async function assertAdapterPushBlocked(gitCommand: string, pushArgs: string[]): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-rogue-push-"));
  const remote = await mkdtemp(path.join(tmpdir(), "donkey-remote-"));
  await writeFile(
    path.join(root, "dev-agent.mjs"),
    [
      "import { spawnSync } from 'node:child_process';",
      `const result = spawnSync(${JSON.stringify(gitCommand)}, ${JSON.stringify(pushArgs)});`,
      "process.exit(result.status ?? 1);",
      "",
    ].join("\n"),
  );
  initGitRepo(root);
  initBareGitRepo(remote);
  git(root, ["remote", "add", "origin", remote]);

  const profile = defaultRepoProfile(root);
  profile.commands.develop = "node dev-agent.mjs {prompt}";
  profile.commands.test = "node --test";
  profile.risk.allowedCommandPatterns = [...profile.risk.allowedCommandPatterns, "^node\\s+dev-agent\\.mjs\\s+.*$"];

  const result = await runProject({
    input: "请开发 feature.txt 并补充测试",
    repoProfile: profile,
    workspaceRoot: root,
  });

  assert.equal(remoteRefExists(remote, "refs/heads/rogue"), false);
  assert.equal(result.status, "failed");
  assert.equal(result.toolRuns.some((tool) => /git commit -m/.test(tool.command)), false);
}

function git(root: string, args: string[]): { stdout: string } {
  const result = spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return { stdout: result.stdout };
}

function remoteRefExists(root: string, ref: string): boolean {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd: root,
    encoding: "utf8",
  });
  return result.status === 0;
}

function chmodHook(root: string, name: string): void {
  const result = spawnSync("chmod", ["755", path.join(root, ".git", "hooks", name)], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
}

function realGitPath(): string {
  const result = spawnSync("which", ["git"], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
