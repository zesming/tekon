import test from "node:test";
import assert from "node:assert/strict";
import { defaultRepoProfile } from "../src/defaults.js";
import { evaluateCommandPolicy, evaluateInputRisk } from "../src/policy.js";

test("blocks configured dangerous commands", () => {
  const result = evaluateCommandPolicy("rm -rf dist", defaultRepoProfile("."));

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /blocked/i);
});

test("allows ordinary test commands", () => {
  const result = evaluateCommandPolicy("node --test", defaultRepoProfile("."));

  assert.equal(result.allowed, true);
});

test("denies commands by default when not allowlisted", () => {
  const result = evaluateCommandPolicy("echo hello", defaultRepoProfile("."));

  assert.equal(result.allowed, false);
  assert.match(result.reason ?? "", /default deny/i);
});

test("blocks shell chaining even when command starts with an allowed prefix", () => {
  const result = evaluateCommandPolicy("npm test && git push", defaultRepoProfile("."));

  assert.equal(result.allowed, false);
});

test("blocks shell control and redirection operators", () => {
  const commands = [
    "npm test & echo hi",
    "npm test\necho hi",
    "npm test > /tmp/out",
    "npm test < package.json",
    "npm test || echo fallback",
    "npm test 2> /tmp/err",
    "npm test $(echo hi)",
  ];

  for (const command of commands) {
    const result = evaluateCommandPolicy(command, defaultRepoProfile("."));
    assert.equal(result.allowed, false, command);
  }
});

test("detects high risk input keywords", () => {
  const result = evaluateInputRisk("需要删除生产数据并扩大权限", defaultRepoProfile("."));

  assert.equal(result.level, "high");
  assert.ok(result.findings.length >= 2);
});
