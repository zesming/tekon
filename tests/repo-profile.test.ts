import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadRepoProfile } from "../src/repo-profile.js";

test("loads partial repo profile by merging default commands and risk policy", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "donkey-profile-partial-"));
  await mkdir(path.join(root, ".donkey"), { recursive: true });
  await writeFile(
    path.join(root, ".donkey", "repo-profile.json"),
    JSON.stringify(
      {
        id: "partial",
        name: "Partial",
        root,
        commands: {
          test: "node --test",
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  const profile = await loadRepoProfile(root);

  assert.equal(profile.commands.test, "node --test");
  assert.ok(profile.risk.highRiskKeywords.includes("secret"));
  assert.ok(profile.risk.allowedCommandPatterns.some((pattern) => pattern.includes("adapter")));
});
