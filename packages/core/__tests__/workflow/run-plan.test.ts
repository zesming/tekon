import { describe, expect, it } from "vitest";

import {
  loadBuiltInWorkflowTemplate,
  loadWorkflowTemplate,
  parseWorkflowTemplate,
} from "../../src/workflow/template.js";
import {
  agentRequiresUnrestrictedNetwork,
  computeRunPlanDigest,
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
    expect(plan.agent).toBe("codex");
    expect(plan.templateId).toBe("sample-flow");
    expect(plan.templateVersion).toBe(1);
  });

  it("normalizes agent to 'codex' by default inside projectRunPlan", () => {
    const template = loadBuiltInWorkflowTemplate("bugfix");

    const defaultPlan = projectRunPlan(template);
    expect(defaultPlan.agent).toBe("codex");
    expect(defaultPlan.requiresUnrestrictedNetwork).toBe(false);

    const explicitPlan = projectRunPlan(template, { agent: "claude-code" });
    expect(explicitPlan.agent).toBe("claude-code");
    expect(explicitPlan.requiresUnrestrictedNetwork).toBe(false);
  });

  it("projects all extended execution fields when provided in context", () => {
    const template = loadBuiltInWorkflowTemplate("bugfix");

    const plan = projectRunPlan(template, {
      agent: "claude-code",
      profile: "custom-profile",
      allowDirtyBase: true,
      timeoutMs: 120000,
      noProgressTimeoutMs: 30000,
      progressHeartbeatMs: 10000,
    });

    expect(plan.agent).toBe("claude-code");
    expect(plan.profile).toBe("custom-profile");
    expect(plan.allowDirtyBase).toBe(true);
    expect(plan.timeoutMs).toBe(120000);
    expect(plan.noProgressTimeoutMs).toBe(30000);
    expect(plan.progressHeartbeatMs).toBe(10000);
    expect(plan.templateId).toBe(template.id);
    expect(plan.templateVersion).toBe(template.version);
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
    expect(plan.agent).toBe("dsh-headless");
    expect(plan.templateId).toBe("goal");
  });
});

describe("computeRunPlanDigest", () => {
  it("produces deterministic 64-char hex sha256 regardless of property order and ignores existing digest", () => {
    const template = loadBuiltInWorkflowTemplate("bugfix");
    const plan = projectRunPlan(template, { agent: "codex", mode: "workflow" });

    expect(typeof plan.digest).toBe("string");
    expect(plan.digest).toMatch(/^[0-9a-f]{64}$/);

    const recomputed = computeRunPlanDigest(plan);
    expect(recomputed).toBe(plan.digest);

    // Property order permutation should produce identical digest
    const reordered = {
      phases: plan.phases,
      gates: plan.gates,
      requiresUnrestrictedNetwork: plan.requiresUnrestrictedNetwork,
      roleChain: plan.roleChain,
      agent: plan.agent,
      templateId: plan.templateId,
      templateVersion: plan.templateVersion,
    };
    expect(computeRunPlanDigest(reordered)).toBe(plan.digest);
  });

  it("changes when plan fields are modified", () => {
    const template = loadBuiltInWorkflowTemplate("bugfix");
    const basePlan = projectRunPlan(template, { agent: "codex", mode: "workflow" });
    const baseDigest = basePlan.digest;

    // Change requiresUnrestrictedNetwork
    const netModified = { ...basePlan, requiresUnrestrictedNetwork: true };
    expect(computeRunPlanDigest(netModified)).not.toBe(baseDigest);

    // Change roleChain
    const roleModified = { ...basePlan, roleChain: [...basePlan.roleChain, "pmo" as const] };
    expect(computeRunPlanDigest(roleModified)).not.toBe(baseDigest);

    // Change gates
    const gateModified = {
      ...basePlan,
      gates: basePlan.gates.map((g, idx) => (idx === 0 ? { ...g, requiresHumanApproval: !g.requiresHumanApproval } : g)),
    };
    expect(computeRunPlanDigest(gateModified)).not.toBe(baseDigest);

    // Change phases
    const phaseModified = {
      ...basePlan,
      phases: basePlan.phases.map((p, idx) => (idx === 0 ? { ...p, name: p.name + " modified" } : p)),
    };
    expect(computeRunPlanDigest(phaseModified)).not.toBe(baseDigest);

    // Change agent
    const agentModified = { ...basePlan, agent: "claude-code" };
    expect(computeRunPlanDigest(agentModified)).not.toBe(baseDigest);

    // Change profile
    const profileModified = { ...basePlan, profile: "profile-v2" };
    expect(computeRunPlanDigest(profileModified)).not.toBe(baseDigest);

    // Change allowDirtyBase
    const dirtyModified = { ...basePlan, allowDirtyBase: true };
    expect(computeRunPlanDigest(dirtyModified)).not.toBe(baseDigest);

    // Change timeoutMs
    const timeoutModified = { ...basePlan, timeoutMs: 60000 };
    expect(computeRunPlanDigest(timeoutModified)).not.toBe(baseDigest);

    // Change noProgressTimeoutMs
    const noProgModified = { ...basePlan, noProgressTimeoutMs: 30000 };
    expect(computeRunPlanDigest(noProgModified)).not.toBe(baseDigest);

    // Change progressHeartbeatMs
    const heartbeatModified = { ...basePlan, progressHeartbeatMs: 15000 };
    expect(computeRunPlanDigest(heartbeatModified)).not.toBe(baseDigest);

    // Change templateId
    const templateIdModified = { ...basePlan, templateId: "custom-template" };
    expect(computeRunPlanDigest(templateIdModified)).not.toBe(baseDigest);

    // Change templateVersion
    const versionModified = { ...basePlan, templateVersion: 2 };
    expect(computeRunPlanDigest(versionModified)).not.toBe(baseDigest);
  });
});
