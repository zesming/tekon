import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import type { AgentAdapterConfig } from '../types/config.js';
import {
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
} from '../types/config.js';
import type { Artifact, CommandInvocation } from '../types/domain.js';
import { redactSecrets } from '../security/secrets.js';
import type { CommandGateway } from './command-gateway.js';
import type { AgentAdapter } from './agent-adapter.js';
import { assertAgentProviderCapabilities } from './agent-adapter.js';
import {
  ingestAgentManifestArtifacts,
  missingRequiredArtifactTypes,
} from './manifest-artifacts.js';
import { runDshPreflight } from './dsh-bridge-probe.js';

// ---------------------------------------------------------------------------
// dsh-headless adapter (phase 5b). Bridges the external `dsh` CLI through its
// only documented machine-consumable surface: `dsh --profile headless "<task>"`
// → stdout (final assistant text) / stderr / exit code (design §3, §4).
//
// Governance posture (design §7, §18):
//   - sandbox pinned to workspace-write via DSH_PERMISSION_MODE (never inherit
//     ambient; danger-full-access rejected by the capability guard);
//   - approval: headless has no answerer → ask fails closed (≈ codex on-request
//     non-interactive auto-deny);
//   - filesystem: single workspace root = cwd = worktree; NO --add-dir
//     equivalent, so artifacts written outside the worktree are impossible →
//     this provider is honestly goal-only (see §4.4);
//   - network: UNRESTRICTED and unfixable in dsh; the profile declares
//     `enabled` and the guard only admits it behind an explicit acknowledgment.
// ---------------------------------------------------------------------------

/** Isolated DSH_HOME under the repo data dir (NOT the worktree) so the agent's
 * sandboxed tools cannot write dsh's session store / profiles, and so a prior
 * run cannot plant a profile that a later run in the same worktree would load
 * (design §4.2). Per-run subdir keeps sessions from accumulating and matches
 * dsh's one-fresh-session-per-run reality. */
const DSH_HOME_ROOT_SUBPATH = ['runs'];

/** Safe environment keys forwarded to the dsh child (mirrors codex/claude). */
const DSH_SAFE_ENV_KEYS = [
  'PATH',
  'HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'LANG',
  'LC_ALL',
  'SHELL',
] as const;

const MAX_ASSISTANT_TEXT_CHARS = 16_000;

function readFinalAssistantText(path: string): string | undefined {
  try {
    const raw = readFileSync(path, 'utf8').trim();
    if (!raw) return undefined;
    const bounded =
      raw.length > MAX_ASSISTANT_TEXT_CHARS
        ? `${raw.slice(0, MAX_ASSISTANT_TEXT_CHARS)}…`
        : raw;
    return redactSecrets(bounded).content;
  } catch {
    return undefined;
  }
}

export interface BuiltDshHeadlessCommand extends CommandInvocation {
  stdin?: undefined;
}

function isRealDshCommand(command: string): boolean {
  return basename(command) === 'dsh';
}

/**
 * Reject any launcher-level control flag in user-supplied args (design §4.3,
 * review M3). `--profile`/`--patch`/`--dump-*` and the `web`/`plugin`
 * subcommands could redirect away from the headless one-shot contract or
 * overlay configuration that overrides the pinned sandbox/approval seams. This
 * mirrors codex's assertSafeCodexArgs: Tekon owns these boundaries.
 */
function assertSafeDshArgs(args: readonly string[]): void {
  if (
    args.some(
      (arg) =>
        arg === '--profile' ||
        arg.startsWith('--profile=') ||
        arg === '--patch' ||
        arg.startsWith('--patch=') ||
        arg === '--dump-config' ||
        arg === '--dump-default-config' ||
        arg === '--version' ||
        arg === '-h' ||
        arg === '--help' ||
        arg === 'web' ||
        arg === 'plugin',
    )
  ) {
    throw new Error(
      'dsh launcher flags (--profile, --patch, --dump-*, --version, web, plugin) are ' +
        'controlled by Tekon',
    );
  }
}

/**
 * Build the dsh headless command. Pins `--profile headless` and passes the
 * whole prompt as ONE positional task arg (multiple words are joined by dsh,
 * but a single argv element also removes any flag-injection surface — defense
 * in depth, design §4.3). The governance framing and arg whitelist apply to
 * EVERY command, including an overridden binary path (enterprise dsh
 * distribution): a wrapper must still receive `--profile headless` + the task,
 * so renaming the binary can never drop the headless contract or the arg
 * whitelist. Note: the execution-time capability gate (runDshPreflight) is
 * keyed on basename(command) === 'dsh' and IS skipped for non-standard names;
 * see #28 for the unified provider command identity contract.
 */
export function buildDshHeadlessCommand(
  config: AgentAdapterConfig,
  input: { prompt: string },
): BuiltDshHeadlessCommand {
  const command = config.command ?? 'dsh';
  const userArgs = config.args ?? [];
  assertSafeDshArgs(userArgs);
  return {
    tool: command,
    args: ['--profile', 'headless', ...userArgs, input.prompt],
    stdin: undefined,
  };
}

/**
 * Build the pinned, non-inherited environment for the dsh child. Governance
 * values are set explicitly and DSH session telemetry is hard-disabled for
 * Tekon's non-interactive subprocess. DEEPSEEK_API_KEY is forwarded only when
 * present in the source environment and is never persisted by Tekon.
 *
 * DSH may still resolve credential fallbacks from the invocation worktree's
 * `.env`; that provenance is outside this environment map and must not be
 * mistaken for an explicitly forwarded process credential.
 */
function buildDshEnv(input: {
  mainRepoPath: string;
  dataDir: string;
  outputDir: string;
  manifestPath: string;
  runId: string;
  nodeId: string;
  source?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  const source = input.source ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const key of DSH_SAFE_ENV_KEYS) {
    if (source[key]) env[key] = source[key];
  }
  // Pinned governance (never inherited from ambient env):
  env.DSH_PERMISSION_MODE = 'workspace-write';
  // The headless bridge exposes no user-facing /feedback flow and Tekon has no
  // telemetry-consent model. Force the upstream hard opt-out rather than
  // inheriting DSH's feedback-gated default or an ambient deployment setting.
  env.DSH_TELEMETRY_DISABLED = '1';
  // DSH_HOME lives under the MAIN repo data dir, OUTSIDE the worktree: dsh's
  // session store / profiles are host-process state the sandboxed agent tools
  // (rooted at cwd = worktree) must not reach or poison across runs (design
  // §4.2, review S2). Built from lease.repoPath (the main repo), NOT
  // runContext.repoPath — the latter equals the worktree path in workflow runs
  // (helpers.ts), which would put DSH_HOME back inside the sandbox root. Keyed
  // per run+node so each run gets a fresh, non-accumulating home.
  env.DSH_HOME = join(
    input.mainRepoPath,
    input.dataDir,
    ...DSH_HOME_ROOT_SUBPATH,
    input.runId,
    `${input.nodeId}-dsh-home`,
  );
  // Artifact protocol passthrough (same contract codex/claude receive).
  env.TEKON_OUTPUT_DIR = input.outputDir;
  env.TEKON_ARTIFACT_MANIFEST = input.manifestPath;
  env.TEKON_RUN_ID = input.runId;
  env.TEKON_NODE_ID = input.nodeId;
  // Explicit environment credential passthrough only when the operator supplied
  // it. This does not disable DSH's own worktree `.env` fallback.
  if (source.DEEPSEEK_API_KEY) {
    env.DEEPSEEK_API_KEY = source.DEEPSEEK_API_KEY;
  }
  return env;
}

export function createDshHeadlessAdapter(
  config: AgentAdapterConfig,
  gateway: CommandGateway,
  options?: {
    /**
     * Version-probe override for tests. Returns the raw `dsh --version` stdout.
     * The shared runDshPreflight implementation owns the real process probe and
     * its timeout so Web, CLI, and direct adapter execution cannot drift.
     */
    probeVersion?: (command: string) => Promise<string>;
    /** Help-probe override for tests. */
    probeHelp?: (command: string) => Promise<string>;
    /** Default-config probe override for tests. */
    probeConfig?: (command: string) => Promise<string>;
    /** Escape hatch: accept this exact untested version (design §5.1). */
    allowVersion?: string;
    onWarn?: (message: string) => void;
    /** Test injection: override the host Node.js version. */
    hostNodeVersion?: string;
    /** Optional timeout for each built-in metadata probe. */
    probeTimeoutMs?: number;
  },
): AgentAdapter {
  // Runs the capability guard, including the phase-5b network-ack carve-out:
  // a dsh-headless config with network:'enabled' constructs only when
  // acknowledgeUnrestrictedNetwork === true; danger-full-access is rejected.
  assertAgentProviderCapabilities(config);

  const dshCommand = config.command ?? 'dsh';
  const realDsh = isRealDshCommand(dshCommand);
  let capabilityGate: Promise<void> | null = null;

  // Lazily run the complete shared preflight once. This is intentionally kept
  // in addition to the pre-persistence Web/CLI check: it catches a binary or
  // environment change between planning and actual job execution. The shared
  // probe owns version, Host Node, help/config checks, and timeout semantics.
  const ensureCapabilityGate = (): Promise<void> => {
    if (!realDsh) return Promise.resolve();
    if (!capabilityGate) {
      capabilityGate = (async () => {
        await runDshPreflight(dshCommand, {
          probeVersion: options?.probeVersion,
          probeHelp: options?.probeHelp,
          probeConfig: options?.probeConfig,
          allowVersion: options?.allowVersion,
          onWarn: options?.onWarn,
          hostNodeVersion: options?.hostNodeVersion,
          probeTimeoutMs: options?.probeTimeoutMs,
        });
      })();
    }
    return capabilityGate;
  };

  return {
    async runAgent(input) {
      const startedAt = Date.now();
      await ensureCapabilityGate();
      const command = buildDshHeadlessCommand(config, { prompt: input.prompt });
      const manifestPath = join(input.outputDir, 'artifact-manifest.json');
      const result = await gateway.run({
        command,
        cwd: input.worktreeLease.worktreePath,
        policy: input.commandPolicy,
        outputDir: input.outputDir,
        timeoutMs: config.timeoutMs,
        progressIntervalMs: config.progressHeartbeatMs,
        noProgressTimeoutMs: config.noProgressTimeoutMs,
        envMode: 'exact',
        env: buildDshEnv({
          // lease.repoPath is the MAIN repo (worktreeLease.worktreePath is the
          // isolated worktree). DSH_HOME must key off the main repo so it lands
          // outside the agent's sandbox root (= worktree). runContext.repoPath
          // is NOT usable here: workflow runs set it to the worktree path.
          mainRepoPath: input.worktreeLease.repoPath,
          dataDir: input.runContext.dataDir,
          outputDir: input.outputDir,
          manifestPath,
          runId: input.runContext.runId,
          nodeId: input.runContext.nodeId,
        }),
        stdin: command.stdin,
        signal: input.signal,
        runId: input.runContext.runId,
        nodeId: input.runContext.nodeId,
      });

      if (result.status !== 'executed') {
        // Pre-spawn cancellation surfaces as rejected+cancelled (gateway
        // contract); propagate it so runAgentWithStepEvents emits step/end
        // {cancelled} rather than a failure.
        if (result.status === 'rejected' && result.cancelled) {
          return {
            provider: 'dsh-headless',
            exitCode: null,
            durationMs: Date.now() - startedAt,
            outputFiles: [],
            cancelled: true,
          };
        }
        return {
          provider: 'dsh-headless',
          exitCode: 1,
          durationMs: Date.now() - startedAt,
          outputFiles: [],
          timedOut: false,
        };
      }

      let artifacts: Artifact[] = [];
      let artifactOutputFiles: string[] = [];
      // dsh cannot write outputDir (outside its workspace sandbox, no add-dir),
      // so a manifest is normally absent. We still attempt ingestion (harmless
      // when none exists) and let missingRequiredArtifactTypes turn any missing
      // required output into a clean failure rather than a false pass — the
      // honest goal-only boundary (design §4.4 S3). Ingestion only reads under
      // outputDir/manifestPath, so it never picks up files the agent wrote
      // inside the worktree; goal runs simply declare no required artifacts.
      if (result.exitCode === 0 && input.artifactStore) {
        try {
          artifacts = await ingestAgentManifestArtifacts({
            runInput: input,
            manifestPath,
          });
          artifactOutputFiles = artifacts.map((artifact) => artifact.path);
        } catch {
          return {
            provider: 'dsh-headless',
            exitCode: 1,
            durationMs: result.durationMs,
            outputFiles: [result.stdoutPath, result.stderrPath],
            timedOut: result.timedOut,
          };
        }
      }

      if (
        result.exitCode === 0 &&
        missingRequiredArtifactTypes(input.requiredArtifactTypes, artifacts)
          .length > 0
      ) {
        return {
          provider: 'dsh-headless',
          exitCode: 1,
          durationMs: result.durationMs,
          outputFiles: [
            result.stdoutPath,
            result.stderrPath,
            ...artifactOutputFiles,
          ],
          artifacts,
          timedOut: result.timedOut,
        };
      }

      return {
        provider: 'dsh-headless',
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputFiles: [
          result.stdoutPath,
          result.stderrPath,
          ...artifactOutputFiles,
        ],
        artifacts,
        assistantText:
          result.exitCode === 0
            ? readFinalAssistantText(result.stdoutPath)
            : undefined,
        timedOut: result.timedOut,
      };
    },
  };
}

/**
 * Build the default dsh-headless AgentAdapterConfig. Carries the explicit
 * unrestricted-network acknowledgment (design §17 decision 3): dsh cannot
 * contain network egress, so the profile honestly declares `network: 'enabled'`
 * and the ack bit is what lets the capability guard construct the adapter.
 * approval defaults to on-request (headless fails closed regardless).
 */
export function dshHeadlessProviderConfig(
  repoPath: string,
  opts?: { approvalDefault?: 'on-failure' | 'on-request' },
): AgentAdapterConfig {
  return {
    provider: 'dsh-headless',
    command: 'dsh',
    args: [],
    promptMode: 'arg-append',
    outputFormat: 'text',
    acknowledgeUnrestrictedNetwork: true,
    timeoutMs: DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
    progressHeartbeatMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
    noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    permissionProfile: {
      sandbox: 'workspace-write',
      approval: opts?.approvalDefault ?? 'on-request',
      filesystemScope: [repoPath],
      network: 'enabled',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
}
