import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../src/intent.js";
import { defaultRepoProfile } from "../src/defaults.js";

test("classifies an idea as demand document target", () => {
  const intent = classifyIntent({
    input: "我想提升内部配置工具的使用体验",
    repoProfile: defaultRepoProfile("."),
  });

  assert.equal(intent.inputType, "idea");
  assert.equal(intent.targetStage, "demand_doc");
  assert.equal(intent.riskLevel, "low");
});

test("classifies an existing technical plan for validation as validation target", () => {
  const intent = classifyIntent({
    input: "这是技术方案，请直接执行测试验收",
    repoProfile: defaultRepoProfile("."),
  });

  assert.equal(intent.inputType, "tech_plan");
  assert.equal(intent.targetStage, "validation_report");
});

test("classifies explicit implementation request as development target", () => {
  const intent = classifyIntent({
    input: "请开发一个本地搜索功能并补充测试",
    repoProfile: defaultRepoProfile("."),
  });

  assert.equal(intent.targetStage, "development");
});

test("classifies technical plan execution as development when validation is not the only goal", () => {
  const intent = classifyIntent({
    input: "已有技术方案，请按方案执行并测试验收",
    repoProfile: defaultRepoProfile("."),
  });

  assert.equal(intent.inputType, "tech_plan");
  assert.equal(intent.targetStage, "development");
});

test("downgrades production and secret changes to risk report", () => {
  const intent = classifyIntent({
    input: "请修改生产发布链路并更新 secret token",
    repoProfile: defaultRepoProfile("."),
    requestedTargetStage: "pull_request",
  });

  assert.equal(intent.riskLevel, "high");
  assert.equal(intent.targetStage, "risk_report");
});

test("downgrades high risk paths to risk report", () => {
  const intent = classifyIntent({
    input: "请修改 .env 文件并提交 PR",
    repoProfile: defaultRepoProfile("."),
    requestedTargetStage: "pull_request",
  });

  assert.equal(intent.riskLevel, "high");
  assert.equal(intent.targetStage, "risk_report");
  assert.match(intent.reasons.join("\n"), /\.env/);
});
