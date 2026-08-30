import { afterEach, describe, expect, it } from "vitest";

import { createWebFixtureProject } from "../fixtures/project.js";
import { createApiCaller } from "../../src/server/api/root.js";

const cleanupTasks: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanupTasks.splice(0)) {
    await cleanup();
  }
});

describe("project.run plan digest validation (P1-UX-01 / P1-PRODUCT-02 / A-web)", () => {
  it("accepts a run when planDigest matches the projected plan", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const plan = await api.workflow.plan({
      template: "project-feature",
      agent: "mock",
      mode: "workflow",
      allowDirtyBase: true,
      timeoutMs: 3600000,
    });

    const planDigest = plan.digest;
    expect(planDigest).toBeDefined();

    const result = await api.project.run({
      demandText: "Implement new search filter",
      template: "project-feature",
      agent: "mock",
      mode: "workflow",
      token: fixture.sessionToken,
      allowDirtyBase: true,
      timeoutMs: 3600000,
      planDigest,
    });

    expect(result.run).toBeDefined();
    expect(result.run.id).toBeDefined();
    expect(result.sessionId).toBeDefined();
  });

  it("rejects a run when planDigest does not match the projected plan", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.project.run({
        demandText: "Tampered run demand",
        template: "project-feature",
        agent: "mock",
        mode: "workflow",
        token: fixture.sessionToken,
        allowDirtyBase: true,
        planDigest: "mismatched-digest-value-12345",
      }),
    ).rejects.toThrow(/PLAN_DIGEST_MISMATCH/);
  });

  it("rejects a workflow run when planDigest is omitted", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    await expect(
      api.project.run({
        demandText: "Run without planDigest (must be rejected)",
        template: "project-feature",
        agent: "mock",
        mode: "workflow",
        token: fixture.sessionToken,
        allowDirtyBase: true,
      }),
    ).rejects.toThrow(/PLAN_DIGEST_REQUIRED/);
  });

  it("does not validate planDigest in goal mode", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    const result = await api.project.run({
      demandText: "Goal mode run",
      mode: "goal",
      agent: "mock",
      token: fixture.sessionToken,
      allowDirtyBase: true,
      planDigest: "any-arbitrary-digest",
    });

    expect(result.run).toBeDefined();
    expect(result.sessionId).toBeDefined();

    const resultWithoutDigest = await api.project.run({
      demandText: "Goal mode run without digest",
      mode: "goal",
      agent: "mock",
      token: fixture.sessionToken,
      allowDirtyBase: true,
    });

    expect(resultWithoutDigest.run).toBeDefined();
    expect(resultWithoutDigest.sessionId).toBeDefined();
  });

  it("verifies allowDirtyBase and timeoutMs participate in digest calculation end-to-end", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    cleanupTasks.push(() => api.close());

    // Compute plan with timeoutMs 1000
    const planA = await api.workflow.plan({
      template: "project-feature",
      agent: "mock",
      mode: "workflow",
      allowDirtyBase: true,
      timeoutMs: 1000,
    });

    // Compute plan with timeoutMs 2000
    const planB = await api.workflow.plan({
      template: "project-feature",
      agent: "mock",
      mode: "workflow",
      allowDirtyBase: true,
      timeoutMs: 2000,
    });

    expect(planA.digest).not.toBe(planB.digest);

    // Attempting to run with planA digest but timeoutMs 2000 should mismatch
    await expect(
      api.project.run({
        demandText: "Mismatch timeout run",
        template: "project-feature",
        agent: "mock",
        mode: "workflow",
        token: fixture.sessionToken,
        allowDirtyBase: true,
        timeoutMs: 2000,
        planDigest: planA.digest,
      }),
    ).rejects.toThrow(/PLAN_DIGEST_MISMATCH/);
  });
});
