import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";

const cliPath = path.resolve("dist/src/cli.js");

test("cli runs validation workflow, reads status, and runs eval", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-cli-"));
  await writeFile(path.join(root, "sample.test.js"), "import test from 'node:test'; test('ok', () => {});\n");

  const run = runCli([
    "run",
    "--repo",
    root,
    "--input",
    "已有技术方案，请直接执行测试验收",
    "--test-command",
    "node --test sample.test.js",
    "--json",
  ]);
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout) as { runId: string; status: string; reportPath: string };
  assert.equal(payload.status, "completed");
  assert.ok(payload.reportPath.endsWith("report.html"));

  const status = runCli(["status", payload.runId, "--repo", root, "--json"]);
  assert.equal(status.status, 0, status.stderr);
  const statusPayload = JSON.parse(status.stdout) as { id: string; targetStage: string; status: string };
  assert.equal(statusPayload.id, payload.runId);
  assert.equal(statusPayload.targetStage, "validation_report");

  const show = runCli(["show", payload.runId, "--repo", root]);
  assert.equal(show.status, 0, show.stderr);
  assert.match(show.stdout, /report.html/);
  const html = await readFile(path.join(root, payload.reportPath), "utf8");
  assert.match(html, /Donkey 交付证据包/);

  const evalRun = runCli(["eval", "--repo", root, "--json"]);
  assert.equal(evalRun.status, 0, evalRun.stderr);
  const evalPayload = JSON.parse(evalRun.stdout) as {
    total: number;
    passed: number;
    highRiskEscapes: number;
    reportPath: string;
  };
  assert.equal(evalPayload.total >= 5, true);
  assert.equal(evalPayload.highRiskEscapes, 0);
  const evalHtml = await readFile(path.join(root, evalPayload.reportPath), "utf8");
  assert.match(evalHtml, /Donkey Eval 评测报告/);
});

test("cli run uses repo profile created by init", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-cli-profile-"));
  await writeFile(path.join(root, "profile.test.js"), "import test from 'node:test'; test('profile ok', () => {});\n");

  const init = runCli(["init", "--repo", root, "--json"]);
  assert.equal(init.status, 0, init.stderr);
  const profilePath = path.join(root, ".donkey", "repo-profile.json");
  const profile = JSON.parse(await readFile(profilePath, "utf8")) as {
    commands: { test: string };
    risk: { allowedCommandPatterns: string[] };
  };
  profile.commands.test = "node --test profile.test.js";
  profile.risk.allowedCommandPatterns = ["^node\\s+--test\\s+profile\\.test\\.js$"];
  await writeFile(profilePath, `${JSON.stringify(profile, null, 2)}\n`, "utf8");

  const run = runCli([
    "run",
    "--repo",
    root,
    "--input",
    "已有技术方案，请直接执行测试验收",
    "--json",
  ]);
  assert.equal(run.status, 0, run.stderr);
  const payload = JSON.parse(run.stdout) as { status: string };
  assert.equal(payload.status, "completed");
});

function runCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}
