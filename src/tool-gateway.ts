import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { RepoProfile, ToolRun } from "./types.js";
import { evaluateCommandPolicy } from "./policy.js";
import { ensureDir, relativePath } from "./fs-store.js";
import { redactSensitive } from "./redact.js";
import { parseCommandLine } from "./command-line.js";

export interface RunCommandOptions {
  command: string;
  cwd: string;
  repoProfile: RepoProfile;
  outputDir: string;
  timeoutMs?: number;
}

export async function runCommand(options: RunCommandOptions): Promise<ToolRun> {
  const startedAt = Date.now();
  const id = `tool-${startedAt}`;
  const policy = evaluateCommandPolicy(options.command, options.repoProfile);
  const logsDir = path.join(options.outputDir, "logs");
  await ensureDir(logsDir);
  const stdoutFile = path.join(logsDir, `${id}.stdout.log`);
  const stderrFile = path.join(logsDir, `${id}.stderr.log`);

  if (!policy.allowed) {
    await writeFile(stderrFile, policy.reason ?? "command blocked", "utf8");
    return {
      id,
      command: redactSensitive(options.command),
      cwd: options.cwd,
      status: "blocked",
      exitCode: null,
      durationMs: Date.now() - startedAt,
      stderrPath: relativePath(options.cwd, stderrFile),
      reason: policy.reason,
    };
  }

  let argv: string[];
  try {
    argv = parseCommandLine(options.command);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid command";
    await writeFile(stderrFile, reason, "utf8");
    return {
      id,
      command: redactSensitive(options.command),
      cwd: options.cwd,
      status: "blocked",
      exitCode: null,
      durationMs: Date.now() - startedAt,
      stderrPath: relativePath(options.cwd, stderrFile),
      reason,
    };
  }

  const result = await spawnCommand(argv, options.cwd, options.timeoutMs ?? 120_000);
  await writeFile(stdoutFile, redact(result.stdout), "utf8");
  await writeFile(stderrFile, redact(result.stderr), "utf8");

  return {
    id,
    command: redactSensitive(options.command),
    cwd: options.cwd,
    status: result.exitCode === 0 ? "passed" : "failed",
    exitCode: result.exitCode,
    durationMs: Date.now() - startedAt,
    stdoutPath: relativePath(options.cwd, stdoutFile),
    stderrPath: relativePath(options.cwd, stderrFile),
    reason: result.timedOut ? "command timed out" : undefined,
  };
}

function spawnCommand(
  argv: string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn(argv[0] ?? "", argv.slice(1), {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: timedOut ? 124 : code ?? 1, timedOut });
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: `${stderr}\n${error.message}`, exitCode: 1, timedOut });
    });
  });
}

function redact(value: string): string {
  return redactSensitive(value);
}
