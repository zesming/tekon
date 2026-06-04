import test from "node:test";
import assert from "node:assert/strict";
import { createAgentRegistry } from "../src/registry.js";
import { defaultAgentProfiles } from "../src/defaults.js";

test("agent registry exposes required built-in profiles by versioned id", () => {
  const registry = createAgentRegistry(defaultAgentProfiles());

  assert.equal(registry.get("intent-agent@0.1.0").role, "Intent");
  assert.equal(registry.get("test-agent@0.1.0").skills.includes("run-tests"), true);
  assert.throws(() => registry.get("missing-agent@0.1.0"), /not found/);
});
