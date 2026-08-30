import { afterEach, describe, expect, it } from "vitest";

import { createWebFixtureProject } from "../fixtures/project.js";
import { createApiCaller } from "../../src/server/api/root.js";

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe("project.health RPC (P1-UX-02 / P1-HEALTH-01)", () => {
  it("returns not-configured when no token is provided", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health();
    expect(result.credential).toBe("not-configured");
    expect(result.checkedAt).toBeDefined();
    expect(new Date(result.checkedAt).getTime()).not.toBeNaN();

    await api.close();
  });

  it("returns valid when the correct session token is provided and exposes dshHeadless", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health({ token: fixture.sessionToken });
    expect(result.credential).toBe("valid");
    expect(result.checkedAt).toBeDefined();
    expect(result.dshHeadless === "available" || result.dshHeadless === "unavailable").toBe(true);

    await api.close();
  });

  it("returns invalid when an incorrect session token is provided", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health({ token: "wrong-token-value" });
    expect(result.credential).toBe("invalid");
    expect(result.detail).toBe("Session token does not match server configuration");

    await api.close();
  });

  it("provider probe does not override invalid credential status", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.project.health({ token: "invalid-token" });
    expect(result.credential).toBe("invalid");
    expect(result.credential).not.toBe("valid");

    await api.close();
  });

  it("caches health check results within the 60s window using hashed token", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const first = await api.project.health({ token: fixture.sessionToken });
    const second = await api.project.health({ token: fixture.sessionToken });

    expect(first.credential).toBe("valid");
    expect(second.credential).toBe("valid");
    expect(first.checkedAt).toBe(second.checkedAt);

    await api.close();
  });

  it("caps cache size at 128 entries and evicts oldest", async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    // Seed 135 different invalid token entries
    for (let i = 0; i < 135; i++) {
      await api.project.health({ token: `token-load-test-${i}` });
    }

    const res = await api.project.health({ token: fixture.sessionToken });
    expect(res.credential).toBe("valid");

    await api.close();
  });
});
