import test from "node:test";
import assert from "node:assert/strict";
import { runEvalCases } from "../src/eval.js";
import { defaultRepoProfile } from "../src/defaults.js";

test("replays eval cases and reports stage accuracy", () => {
  const results = runEvalCases(
    [
      {
        id: "idea-to-demand",
        input: "我想做一个任务筛选优化",
        expectedInputType: "idea",
        expectedTargetStage: "demand_doc",
      },
      {
        id: "risk-downgrade",
        input: "请删除生产数据",
        expectedInputType: "idea",
        expectedTargetStage: "risk_report",
      },
    ],
    defaultRepoProfile("."),
  );

  assert.equal(results.summary.total, 2);
  assert.equal(results.summary.passed, 2);
  assert.equal(results.results.every((result) => result.passed), true);
});

test("reports target stage accuracy separately from pass rate", () => {
  const results = runEvalCases(
    [
      {
        id: "target-correct-type-wrong",
        input: "请删除生产数据",
        expectedInputType: "demand",
        expectedTargetStage: "risk_report",
      },
    ],
    defaultRepoProfile("."),
  );

  assert.equal(results.summary.passed, 0);
  assert.equal(results.summary.passRate, 0);
  assert.equal(results.summary.inputTypeAccuracy, 0);
  assert.equal(results.summary.targetStageAccuracy, 1);
});
