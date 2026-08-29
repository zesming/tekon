import { describe, expect, it } from "vitest";

import {
  loadBuiltInWorkflowTemplate,
  loadWorkflowTemplate,
  parseWorkflowTemplate,
} from "../../src/workflow/template.js";
import {
  agentRequiresUnrestrictedNetwork,
  projectRunPlan,
} from "../../src/workflow/run-plan.js";

describe("agentRequiresUnrestrictedNetwork", () => {
  it("returns true only for dsh-headless and false for others", () => {
    expect(agentRequiresUnrestrictedNetwork("dsh-headless")).toBe(true);
    expect(agentRequiresUnrestrictedNetwork("codex")).toBe(false);
    expect(agentRequiresUnrestrictedNetwork("claude-code")).toBe(false);
    expect(agentRequiresUnrestrictedNetwork("mock")).toBe(false);
    expect(agentRequiresUnrestrictedNetwork(undefined)).toBe(false);
    expect(agentRequiresUnrestrictedNetwork("")).toBe(false);
  });
});

describe("projectRunPlan", () => {
  it("projects phases, roleChain, and gates from a workflow template", () => {
    const template = parseWorkflowTemplate(`
id: sample-flow
name: Sample Flow
phases:
  - id: plan
    name: Planning Phase
    parallel: false
    nodes:
      - id: plan-node
        role: pm
        outputs:
          - prd:prd
        gates:
          - type: schema
            artifactType: prd
          - type: human
            requiresHumanApproval: true
            timeoutMs: 60000
  - id: dev
    name: Development Phase
    parallel: false
    dependsOn: [plan]
    nodes:
      - id: dev-node
        role: rd
        inputs:
          - from: plan-node
            type: prd
        outputs:
          - code-changes:code-changes
        gates:
          - type: build
          - type: lint
  - id: review
    name: Review Phase
    parallel: false
    dependsOn: [dev]
    nodes:
      - id: rev-node
        role: reviewer
        inputs:
          - from: dev-node
            type: code-changes
        gates:
          - type: independent-review
`);

    const plan = projectRunPlan(template, { agent: "codex", mode: "workflow" });

    expect(plan.roleChain).toEqual(["pm", "rd", "reviewer"]);
    expect(plan.requiresUnrestrictedNetwork).toBe(false);
    expect(plan.phases).toEqual([
      {
        id: "plan",
        name: "Planning Phase",
        parallel: false,
        nodeIds: ["plan-node"],
      },
      {
        id: "dev",
        name: "Development Phase",
        parallel: false,
        nodeIds: ["dev-node"],
      },
      {
        id: "review",
        name: "Review Phase",
        parallel: false,
        nodeIds: ["rev-node"],
      },
    ]);

    expect(plan.gates).toEqual([
      {
        nodeId: "plan-node",
        role: "pm",
        type: "schema",
        requiresHumanApproval: false,
      },
      {
        nodeId: "plan-node",
        role: "pm",
        type: "human",
        requiresHumanApproval: true,
        timeoutMs: 60000,
      },
      {
        nodeId: "dev-node",
        role: "rd",
        type: "build",
        requiresHumanApproval: false,
      },
      {
        nodeId: "dev-node",
        role: "rd",
        type: "lint",
        requiresHumanApproval: false,
      },
      {
        nodeId: "rev-node",
        role: "reviewer",
        type: "independent-review",
        requiresHumanApproval: false,
      },
    ]);
  });

  it("sets requiresUnrestrictedNetwork to true only for dsh-headless agent", () => {
    const template = loadBuiltInWorkflowTemplate("bugfix");

    const defaultPlan = projectRunPlan(template);
    expect(defaultPlan.requiresUnrestrictedNetwork).toBe(false);

    const codexPlan = projectRunPlan(template, { agent: "codex" });
    expect(codexPlan.requiresUnrestrictedNetwork).toBe(false);

    const claudePlan = projectRunPlan(template, { agent: "claude-code" });
    expect(claudePlan.requiresUnrestrictedNetwork).toBe(false);

    const dshPlan = projectRunPlan(template, { agent: "dsh-headless" });
    expect(dshPlan.requiresUnrestrictedNetwork).toBe(true);
  });

  it("projects goal mode run plan from goal template correctly", () => {
    const goalTemplate = loadWorkflowTemplate({ name: "goal" });
    const plan = projectRunPlan(goalTemplate, {
      agent: "dsh-headless",
      mode: "goal",
    });

    expect(plan.roleChain).toEqual(["goal"]);
    expect(plan.requiresUnrestrictedNetwork).toBe(true);
    expect(plan.gates).toEqual([]);
    expect(plan.phases).toEqual([
      {
        id: "goal",
        name: "Goal",
        parallel: false,
        nodeIds: ["goal-execute"],
      },
    ]);
  });
});
