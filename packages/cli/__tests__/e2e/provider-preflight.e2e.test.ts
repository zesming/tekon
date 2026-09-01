import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";
import {
  DSH_NODE_REQUIREMENT,
  TESTED_DSH_VERSION,
} from "@tekon/core";

import {
  createFakeDsh,
  VALID_DSH_CONFIG,
} from "../helpers/fake-dsh.js";

describe("tekon provider preflight e2e", () => {
  const tempDirs: string[] = [];
  const cliPackageRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "..",
  );

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it("runs provider preflight dsh-headless against a matching fake dsh in PATH", () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), "tekon-e2e-fake-dsh-"));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: "dsh headless --help\nprint the final assistant message on stdout",
      config: VALID_DSH_CONFIG,
    });

    const cliPath = join(cliPackageRoot, "dist", "index.js");
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
    };

    const output = execFileSync(
      process.execPath,
      [cliPath, "provider", "preflight", "dsh-headless", "--host-node-version", "22.19.0"],
      { encoding: "utf8", env },
    );

    expect(output).toContain(`测试基准版本: ${TESTED_DSH_VERSION}`);
    expect(output).toContain(`当前检测版本: ${TESTED_DSH_VERSION}`);
    expect(output).toContain("宿主 Node: 22.19.0 (兼容)");
    expect(output).toContain(`DSH Node 要求: ${DSH_NODE_REQUIREMENT}`);
    expect(output).toContain("Help 合同检查: 通过");
    expect(output).toContain("Config 合同检查: 通过");
    expect(output).toContain("兼容性结论: 兼容");
    expect(output).toContain(
      `安装指引: npm install -g @deepseek-ai/dsh@${TESTED_DSH_VERSION}`,
    );
  });

  it("runs provider preflight dsh-headless --json returning parseable JSON", () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), "tekon-e2e-fake-dsh-"));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: "print the final assistant message",
      config: VALID_DSH_CONFIG,
    });

    const cliPath = join(cliPackageRoot, "dist", "index.js");
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
    };

    const output = execFileSync(
      process.execPath,
      [cliPath, "provider", "preflight", "dsh-headless", "--json", "--host-node-version", "22.19.0"],
      { encoding: "utf8", env },
    );

    const parsed = JSON.parse(output);
    expect(parsed.testedVersion).toBe(TESTED_DSH_VERSION);
    expect(parsed.actualVersion).toBe(TESTED_DSH_VERSION);
    expect(parsed.nodeRequirement).toBe(DSH_NODE_REQUIREMENT);
    expect(parsed.installHint).toBe(
      `npm install -g @deepseek-ai/dsh@${TESTED_DSH_VERSION}`,
    );
    expect(parsed.helpContractOk).toBe(true);
    expect(parsed.configContractOk).toBe(true);
    expect(parsed.hostNodeVersion).toBe("22.19.0");
    expect(parsed.hostNodeCompatible).toBe(true);
    expect(parsed.hostNodeBypassed).toBe(false);
    expect(parsed.compatible).toBe(true);
  });

  it("runs provider preflight dsh-headless with incompatible host node returning exit code 1", () => {
    const cliPath = join(cliPackageRoot, "dist", "index.js");
    const res = spawnSync(
      process.execPath,
      [cliPath, "provider", "preflight", "dsh-headless", "--host-node-version", "20.19.0"],
      { encoding: "utf8" },
    );

    expect(res.status).toBe(1);
    expect(res.stdout).toContain("当前检测版本: 宿主 Node 不兼容");
    expect(res.stdout).toContain("宿主 Node: 20.19.0 (不兼容)");
    expect(res.stdout).toContain("兼容性结论: 不兼容");
  });

  it("runs provider preflight dsh-headless --json with incompatible host node", () => {
    const cliPath = join(cliPackageRoot, "dist", "index.js");
    const res = spawnSync(
      process.execPath,
      [cliPath, "provider", "preflight", "dsh-headless", "--json", "--host-node-version", "20.19.0"],
      { encoding: "utf8" },
    );

    expect(res.status).toBe(1);
    const parsed = JSON.parse(res.stdout);
    expect(parsed).toMatchObject({
      actualVersion: null,
      hostNodeVersion: "20.19.0",
      hostNodeCompatible: false,
      hostNodeBypassed: false,
      failureKind: "host-node",
      compatible: false,
    });
  });

  it("runs provider preflight dsh-headless with incompatible host node bypassed via TEKON_DSH_ALLOW_HOST_NODE", () => {
    const fakeBinDir = mkdtempSync(join(tmpdir(), "tekon-e2e-fake-dsh-"));
    tempDirs.push(fakeBinDir);
    createFakeDsh(fakeBinDir, {
      version: TESTED_DSH_VERSION,
      help: "dsh headless --help\nprint the final assistant message on stdout",
      config: VALID_DSH_CONFIG,
    });

    const cliPath = join(cliPackageRoot, "dist", "index.js");
    const env = {
      ...process.env,
      PATH: `${fakeBinDir}${delimiter}${process.env.PATH ?? ""}`,
      TEKON_DSH_ALLOW_HOST_NODE: "20.19.0",
    };

    const res = spawnSync(
      process.execPath,
      [cliPath, "provider", "preflight", "dsh-headless", "--host-node-version", "20.19.0"],
      { encoding: "utf8", env },
    );

    expect(res.status).toBe(0);
    expect(res.stdout).toContain("宿主 Node: 20.19.0 (已旁路)");
    expect(res.stdout).toContain("兼容性结论: 兼容");
    expect(res.stderr).toContain(
      "[dsh bridge] host Node check bypassed via TEKON_DSH_ALLOW_HOST_NODE='20.19.0'",
    );
  });

  it("runs help provider showing preflight subcommand", () => {
    const cliPath = join(cliPackageRoot, "dist", "index.js");
    const output = execFileSync(
      process.execPath,
      [cliPath, "help", "provider"],
      { encoding: "utf8" },
    );
    expect(output).toContain("tekon provider");
    expect(output).toContain("preflight");
  });
});
