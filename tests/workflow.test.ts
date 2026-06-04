import test from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../src/intent.js";
import { defaultRepoProfile } from "../src/defaults.js";
import { planWorkflow } from "../src/workflow.js";

test("plans idea workflow without development stages", () => {
  const repoProfile = defaultRepoProfile(".");
  const intent = classifyIntent({ input: "我想优化配置体验", repoProfile });
  const workflow = planWorkflow(intent);

  assert.equal(workflow.targetStage, "demand_doc");
  assert.ok(workflow.stages.some((stage) => stage.id === "demand_document"));
  assert.ok(workflow.stages.find((stage) => stage.id === "implementation")?.skipped);
});

test("plans technical plan execution by skipping demand document stage", () => {
  const repoProfile = defaultRepoProfile(".");
  const intent = classifyIntent({ input: "已有技术方案，请直接执行测试", repoProfile });
  const workflow = planWorkflow(intent);

  assert.equal(workflow.inputType, "tech_plan");
  assert.ok(workflow.stages.find((stage) => stage.id === "demand_document")?.skipped);
  assert.equal(workflow.stages.find((stage) => stage.id === "implementation")?.skipped, true);
  assert.equal(workflow.stages.find((stage) => stage.id === "validation")?.skipped, false);
});

test("plans development workflow with implementation and validation stages", () => {
  const repoProfile = defaultRepoProfile(".");
  const intent = classifyIntent({ input: "已有技术方案，请按方案执行", repoProfile });
  const workflow = planWorkflow(intent);

  assert.equal(workflow.inputType, "tech_plan");
  assert.equal(workflow.targetStage, "development");
  assert.equal(workflow.stages.find((stage) => stage.id === "demand_document")?.skipped, true);
  assert.equal(workflow.stages.find((stage) => stage.id === "implementation")?.skipped, false);
  assert.equal(workflow.stages.find((stage) => stage.id === "validation")?.skipped, false);
});
