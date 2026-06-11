import { readFileSync } from 'node:fs';

import {
  createCommandGateway,
  type CommandGateway,
  type CommandGatewayResult,
} from '../runtime/command-gateway.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
  type CommandPolicy,
} from '../types/config.js';
import type { CommandInvocation } from '../types/domain.js';

export interface ScmDeliveryCommandResult {
  dryRun: boolean;
  requiresHumanApproval: boolean;
  commands: string[][];
  status: ScmStatus;
  prUrl?: string;
}

export interface ScmStatus {
  hasRemote: boolean;
  remoteName?: string;
  remoteUrl?: string;
  currentBranch?: string;
  dirty: boolean;
  ghAuthenticated: boolean;
  branchPushed: boolean;
  pushRequiresHumanApproval: boolean;
  prRequiresHumanApproval: boolean;
  authError?: string;
}

export interface ScmDelivery {
  getStatus(input?: { branch?: string }): Promise<ScmStatus>;
  createPr(input: {
    runId?: string;
    title: string;
    body: string;
    bodyPath?: string;
    branch: string;
    baseBranch?: string;
    dryRun: boolean;
    humanApproved?: boolean;
    approvedBy?: string;
  }): Promise<ScmDeliveryCommandResult>;
}

export interface CreateScmDeliveryOptions {
  repoPath: string;
  env?: NodeJS.ProcessEnv;
  gateway?: CommandGateway;
  outputDir?: string;
  repositories?: TekonRepositories;
  audit?: AuditLogger;
}

export function createScmDelivery(
  options: CreateScmDeliveryOptions,
): ScmDelivery {
  return {
    async getStatus(input) {
      return getScmStatus(options, input?.branch);
    },

    async createPr(input) {
      const baseBranch = input.baseBranch ?? 'main';
      assertSafeGitBranchRef(input.branch, 'branch');
      assertSafeGitBranchRef(baseBranch, 'baseBranch');
      const gateway = options.gateway ?? createCommandGateway();
      const bodyArg = input.bodyPath
        ? ['--body-file', input.bodyPath]
        : ['--body', input.body];
      const prCreateCommand = [
        'gh',
        'pr',
        'create',
        '--title',
        input.title,
        ...bodyArg,
        '--head',
        input.branch,
        '--base',
        baseBranch,
      ];
      const recoveryCommand = [
        'gh',
        'pr',
        'view',
        input.branch,
        '--json',
        'url',
        '--jq',
        '.url',
      ];
      const status = await getScmStatus(options, input.branch);
      await upsertDeliveryState({
        options,
        input,
        baseBranch,
        status,
        nextStatus: input.humanApproved ? 'creating-pr' : 'awaiting-approval',
      });
      let branchSetupCommand: string[] | null;
      try {
        branchSetupCommand = (await localBranchExists(
          gateway,
          options,
          input.branch,
        ))
          ? null
          : ['git', 'branch', input.branch];
      } catch (error) {
        await markDeliveryFailed(options, input.runId, 'branch-probe', error);
        throw error;
      }
      let dirtyWorktree: boolean;
      try {
        dirtyWorktree = await hasCommittableChanges(gateway, options);
      } catch (error) {
        await markDeliveryFailed(options, input.runId, 'dirty-worktree', error);
        throw error;
      }
      const commands: string[][] = [
        ...(branchSetupCommand ? [branchSetupCommand] : []),
        ['git', 'push', '-u', 'origin', input.branch],
        prCreateCommand,
      ];

      if (input.dryRun) {
        return {
          dryRun: true,
          requiresHumanApproval: true,
          commands,
          status,
        };
      }

      if (!input.humanApproved) {
        await appendDeliveryAudit(
          options,
          input.runId,
          'delivery.pr.awaiting-approval',
          {
            branch: input.branch,
            baseBranch,
          },
        );
        return {
          dryRun: false,
          requiresHumanApproval: true,
          commands,
          status,
        };
      }

      const policy = createDeliveryCommandPolicy(options.repoPath, [
        ...(branchSetupCommand ? [branchSetupCommand] : []),
        ['git', 'push', '-u', 'origin', input.branch],
        prCreateCommand,
        recoveryCommand,
      ]);
      const executedCommands: string[][] = [];
      if (dirtyWorktree) {
        const error = new Error(
          'delivery create-pr requires a clean worktree outside .tekon; commit or stash local changes before creating a PR',
        );
        await markDeliveryFailed(options, input.runId, 'dirty-worktree', error);
        throw error;
      }
      try {
        if (branchSetupCommand) {
          await runDeliveryCommand({
            gateway,
            command: toInvocation(branchSetupCommand),
            options,
            policy,
          });
          executedCommands.push(branchSetupCommand);
        }
        const pushCommand = ['git', 'push', '-u', 'origin', input.branch];
        await runDeliveryCommand({
          gateway,
          command: toInvocation(pushCommand),
          options,
          policy,
        });
        executedCommands.push(pushCommand);
        await markBranchPushed(options, input.runId);
      } catch (error) {
        await markDeliveryFailed(options, input.runId, 'push-branch', error);
        throw error;
      }

      let prUrl: string | undefined;
      try {
        const prResult = await runDeliveryCommand({
          gateway,
          command: toInvocation(prCreateCommand),
          options,
          policy,
        });
        executedCommands.push(prCreateCommand);
        prUrl = parsePrUrl(readLastOutputLine(prResult.stdoutPath));
        if (!prUrl) {
          throw new Error('gh pr create did not return a PR URL');
        }
      } catch (error) {
        prUrl = await recoverExistingPrUrl({
          gateway,
          command: recoveryCommand,
          options,
          policy,
        });
        if (!prUrl) {
          await markDeliveryFailed(options, input.runId, 'create-pr', error);
          throw error;
        }
        executedCommands.push(recoveryCommand);
        await appendDeliveryAudit(
          options,
          input.runId,
          'delivery.pr.recovered',
          {
            branch: input.branch,
            baseBranch,
            prUrl,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }

      const finalStatus = await getScmStatus(options, input.branch);
      await markDeliveryCreated(options, input.runId, prUrl, finalStatus);
      await appendDeliveryAudit(options, input.runId, 'delivery.pr.created', {
        branch: input.branch,
        baseBranch,
        prUrl,
      });

      return {
        dryRun: false,
        requiresHumanApproval: false,
        commands: executedCommands,
        status: finalStatus,
        prUrl,
      };
    },
  };
}

async function getScmStatus(
  options: CreateScmDeliveryOptions,
  branch?: string,
): Promise<ScmStatus> {
  if (branch) {
    assertSafeGitBranchRef(branch, 'branch');
  }
  const gateway = options.gateway ?? createCommandGateway();
  const remoteName = remoteNameFromList(
    (
      await runScmStatusCommand({
        gateway,
        command: { tool: 'git', args: ['remote', '-v'] },
        options,
      })
    ).stdout,
  );
  const remoteUrl = remoteName
    ? firstOutputLine(
        (
          await runScmStatusCommand({
            gateway,
            command: { tool: 'git', args: ['remote', 'get-url', remoteName] },
            options,
          })
        ).stdout,
      )
    : undefined;
  const branchResult = await runScmStatusCommand({
    gateway,
    command: { tool: 'git', args: ['branch', '--show-current'] },
    options,
  });
  const currentBranch =
    firstOutputLine(branchResult.stdout) ??
    firstOutputLine(
      (
        await runScmStatusCommand({
          gateway,
          command: { tool: 'git', args: ['rev-parse', '--abbrev-ref', 'HEAD'] },
          options,
        })
      ).stdout,
    );
  const dirty = Boolean(
    (
      await runScmStatusCommand({
        gateway,
        command: { tool: 'git', args: ['status', '--short'] },
        options,
      })
    ).stdout?.trim(),
  );
  const auth = await runScmStatusCommand({
    gateway,
    command: { tool: 'gh', args: ['auth', 'status'] },
    options,
  });
  const branchPushed =
    remoteName && branch
      ? (
          await runScmStatusCommand({
            gateway,
            command: {
              tool: 'git',
              args: ['ls-remote', '--exit-code', '--heads', remoteName, branch],
            },
            options,
          })
        ).exitCode === 0
      : false;

  return {
    hasRemote: Boolean(remoteName),
    remoteName,
    remoteUrl,
    currentBranch,
    dirty,
    ghAuthenticated: auth.exitCode === 0,
    branchPushed: Boolean(branchPushed),
    pushRequiresHumanApproval: true,
    prRequiresHumanApproval: true,
    authError: auth.exitCode === 0 ? undefined : formatStatusCommandError(auth),
  };
}

function createDeliveryCommandPolicy(
  repoPath: string,
  commands: string[][],
): CommandPolicy {
  return {
    allow: commands.map((command) => ({
      ...toInvocation(command),
      match: 'exact',
    })),
    deny: [{ tool: 'git', args: ['push', '--force'] }],
    requiresHumanApproval: [],
    cwdScope: [repoPath],
    network: 'enabled',
  };
}

function assertSafeGitBranchRef(ref: string, label: string): void {
  if (!isSafeGitBranchRef(ref)) {
    throw new Error(`unsafe ${label}: ${ref}`);
  }
}

function isSafeGitBranchRef(ref: string): boolean {
  if (
    ref.length === 0 ||
    ref.length > 240 ||
    ref.startsWith('-') ||
    ref.startsWith(':') ||
    ref.startsWith('/') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.includes('//') ||
    ref.includes('..') ||
    ref.includes('@{') ||
    /[\s\0\\:*?[~^]/u.test(ref)
  ) {
    return false;
  }
  return ref
    .split('/')
    .every(
      (part) =>
        part.length > 0 &&
        part !== '.' &&
        part !== '..' &&
        !part.endsWith('.lock'),
    );
}

function createScmStatusCommandPolicy(
  repoPath: string,
  command: CommandInvocation,
): CommandPolicy {
  return {
    allow: [
      { tool: 'git', args: ['remote', '-v'], match: 'exact' },
      { tool: 'git', args: ['branch', '--show-current'], match: 'exact' },
      {
        tool: 'git',
        args: ['rev-parse', '--abbrev-ref', 'HEAD'],
        match: 'exact',
      },
      { tool: 'git', args: ['status', '--short'], match: 'exact' },
      { tool: 'gh', args: ['auth', 'status'], match: 'exact' },
      { ...command, match: 'exact' },
    ],
    deny: [{ tool: 'git', args: ['push', '--force'] }],
    requiresHumanApproval: [],
    cwdScope: [repoPath],
    network: 'enabled',
  };
}

async function runScmStatusCommand(input: {
  gateway: CommandGateway;
  command: CommandInvocation;
  options: CreateScmDeliveryOptions;
}): Promise<{
  exitCode: number;
  stdout?: string;
  stderr?: string;
  timedOut?: boolean;
  timeoutReason?: 'total' | 'no-progress';
  progressPath?: string;
  rejectedReason?: string;
}> {
  const result = await input.gateway.run({
    command: input.command,
    cwd: input.options.repoPath,
    env: scmStatusCommandEnv(input.options),
    envMode: 'exact',
    outputDir: input.options.outputDir,
    timeoutMs: DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
    progressIntervalMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
    noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    policy: createScmStatusCommandPolicy(input.options.repoPath, input.command),
  });

  if (result.status !== 'executed') {
    return {
      exitCode: 1,
      rejectedReason:
        result.status === 'rejected' ? result.reason : result.decisionId,
    };
  }

  return {
    exitCode: result.exitCode ?? 1,
    stdout: readCommandOutput(result.stdoutPath),
    stderr: readCommandOutput(result.stderrPath),
    timedOut: result.timedOut,
    timeoutReason: result.timeoutReason,
    progressPath: result.progressPath,
  };
}

function scmStatusCommandEnv(
  options: CreateScmDeliveryOptions,
): NodeJS.ProcessEnv {
  return { ...process.env, ...(options.env ?? {}) };
}

async function runDeliveryCommand(input: {
  gateway: CommandGateway;
  command: CommandInvocation;
  options: CreateScmDeliveryOptions;
  policy: CommandPolicy;
}): Promise<Extract<CommandGatewayResult, { status: 'executed' }>> {
  const result = await input.gateway.run({
    command: input.command,
    cwd: input.options.repoPath,
    env: input.options.env,
    envMode: input.options.env ? 'inherit' : 'safe-default',
    outputDir: input.options.outputDir,
    timeoutMs: DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
    progressIntervalMs: DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
    noProgressTimeoutMs: DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
    policy: input.policy,
  });

  if (result.status !== 'executed') {
    const detail =
      result.status === 'rejected' ? result.reason : result.decisionId;
    throw new Error(`delivery command ${result.status}: ${detail}`);
  }

  if (result.timedOut) {
    throw new Error(
      [
        `delivery command timed out`,
        result.timeoutReason ? `reason=${result.timeoutReason}` : null,
        result.progressPath ? `progress=${result.progressPath}` : null,
        `${input.command.tool} ${input.command.args.join(' ')}`,
      ]
        .filter(Boolean)
        .join(' '),
    );
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `delivery command failed with exit code ${result.exitCode}: ${input.command.tool} ${input.command.args.join(' ')}`,
    );
  }

  return result;
}

function toInvocation(command: string[]): CommandInvocation {
  const [tool, ...args] = command;
  return { tool, args };
}

function readLastOutputLine(stdoutPath: string): string | undefined {
  const output = readFileSync(stdoutPath, 'utf8').trim();
  return output.length === 0 ? undefined : output.split(/\r?\n/u).at(-1);
}

function readCommandOutput(path: string): string | undefined {
  try {
    const output = readFileSync(path, 'utf8').trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function firstOutputLine(output: string | undefined): string | undefined {
  return output?.split(/\r?\n/u).find((line) => line.trim().length > 0);
}

function remoteNameFromList(output: string | undefined): string | undefined {
  const line = firstOutputLine(output);
  return line?.trim().split(/\s+/u).at(0);
}

function formatStatusCommandError(input: {
  exitCode: number;
  stderr?: string;
  timedOut?: boolean;
  timeoutReason?: 'total' | 'no-progress';
  progressPath?: string;
  rejectedReason?: string;
}): string {
  if (input.stderr) {
    return input.stderr;
  }
  if (input.timedOut) {
    return [
      `status command timed out`,
      input.timeoutReason ? `reason=${input.timeoutReason}` : null,
      input.progressPath ? `progress=${input.progressPath}` : null,
    ]
      .filter(Boolean)
      .join(' ');
  }
  return (
    input.rejectedReason ??
    `status command failed with exit code ${input.exitCode}`
  );
}

function parsePrUrl(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? trimmed
      : undefined;
  } catch {
    return undefined;
  }
}

async function recoverExistingPrUrl(input: {
  gateway: CommandGateway;
  command: string[];
  options: CreateScmDeliveryOptions;
  policy: CommandPolicy;
}): Promise<string | undefined> {
  try {
    const result = await runDeliveryCommand({
      gateway: input.gateway,
      command: toInvocation(input.command),
      options: input.options,
      policy: input.policy,
    });
    return parsePrUrl(readLastOutputLine(result.stdoutPath));
  } catch {
    return undefined;
  }
}

async function localBranchExists(
  gateway: CommandGateway,
  options: CreateScmDeliveryOptions,
  branch: string,
): Promise<boolean> {
  const command = {
    tool: 'git',
    args: ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
  };
  const result = await runScmStatusCommand({
    gateway,
    command,
    options,
  });
  assertStatusProbeResult({ command, result, allowedExitCodes: [0, 1] });
  return result.exitCode === 0;
}

async function hasCommittableChanges(
  gateway: CommandGateway,
  options: CreateScmDeliveryOptions,
): Promise<boolean> {
  const command = { tool: 'git', args: ['status', '--porcelain'] };
  const result = await runScmStatusCommand({
    gateway,
    command,
    options,
  });
  assertStatusProbeResult({ command, result, allowedExitCodes: [0] });
  const status = result.stdout ?? '';
  return status
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .some((line) => !line.startsWith('?? .tekon/'));
}

function assertStatusProbeResult(input: {
  command: CommandInvocation;
  result: Awaited<ReturnType<typeof runScmStatusCommand>>;
  allowedExitCodes: number[];
}): void {
  if (
    input.result.timedOut ||
    input.result.rejectedReason ||
    !input.allowedExitCodes.includes(input.result.exitCode)
  ) {
    throw new Error(
      `SCM probe failed: ${input.command.tool} ${input.command.args.join(' ')} ${formatStatusCommandError(input.result)}`,
    );
  }
}

async function upsertDeliveryState(input: {
  options: CreateScmDeliveryOptions;
  input: {
    runId?: string;
    title: string;
    bodyPath?: string;
    branch: string;
    humanApproved?: boolean;
    approvedBy?: string;
  };
  baseBranch: string;
  status: ScmStatus;
  nextStatus: 'awaiting-approval' | 'creating-pr';
}) {
  if (!input.options.repositories || !input.input.runId) {
    return;
  }
  const existing = await input.options.repositories.getDeliveryPullRequest(
    input.input.runId,
  );
  const now = new Date().toISOString();
  await input.options.repositories.upsertDeliveryPullRequest({
    id: existing?.id ?? `delivery_pr_${input.input.runId}`,
    runId: input.input.runId,
    branch: input.input.branch,
    baseBranch: input.baseBranch,
    title: input.input.title,
    bodyPath: input.input.bodyPath ?? existing?.bodyPath ?? null,
    remoteName: input.status.remoteName ?? existing?.remoteName ?? null,
    remoteUrl: input.status.remoteUrl ?? existing?.remoteUrl ?? null,
    status: existing?.status === 'created' ? 'created' : input.nextStatus,
    prUrl: existing?.prUrl ?? null,
    approvedBy: input.input.humanApproved
      ? (input.input.approvedBy ?? 'cli')
      : (existing?.approvedBy ?? null),
    approvedAt: input.input.humanApproved
      ? (existing?.approvedAt ?? now)
      : (existing?.approvedAt ?? null),
    branchPushedAt: existing?.branchPushedAt ?? null,
    prCreatedAt: existing?.prCreatedAt ?? null,
    failureStage: null,
    lastError: null,
    attemptCount: (existing?.attemptCount ?? 0) + 1,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  });
}

async function markBranchPushed(
  options: CreateScmDeliveryOptions,
  runId: string | undefined,
) {
  if (!options.repositories || !runId) {
    return;
  }
  const existing = await options.repositories.getDeliveryPullRequest(runId);
  if (!existing) {
    return;
  }
  const now = new Date().toISOString();
  await options.repositories.upsertDeliveryPullRequest({
    ...existing,
    status: 'branch-pushed',
    branchPushedAt: existing.branchPushedAt ?? now,
    updatedAt: now,
  });
}

async function markDeliveryCreated(
  options: CreateScmDeliveryOptions,
  runId: string | undefined,
  prUrl: string,
  status: ScmStatus,
) {
  if (!options.repositories || !runId) {
    return;
  }
  await options.repositories.markDeliveryPullRequestCreated({
    runId,
    prUrl,
    remoteName: status.remoteName,
    remoteUrl: status.remoteUrl,
    createdAt: new Date().toISOString(),
  });
}

async function markDeliveryFailed(
  options: CreateScmDeliveryOptions,
  runId: string | undefined,
  stage: string,
  error: unknown,
) {
  if (!options.repositories || !runId) {
    return;
  }
  await options.repositories.markDeliveryPullRequestFailed({
    runId,
    failureStage: stage,
    lastError: error instanceof Error ? error.message : String(error),
    failedAt: new Date().toISOString(),
  });
}

async function appendDeliveryAudit(
  options: CreateScmDeliveryOptions,
  runId: string | undefined,
  type: string,
  payload: Record<string, unknown>,
) {
  if (!options.audit || !runId) {
    return;
  }
  await options.audit.append({ runId, type, payload });
}
