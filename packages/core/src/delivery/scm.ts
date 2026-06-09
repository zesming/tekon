import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  createCommandGateway,
  type CommandGateway,
  type CommandGatewayResult,
} from '../runtime/command-gateway.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { CommandPolicy } from '../types/config.js';
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
      const env = { ...process.env, ...(options.env ?? {}) };
      const bodyArg = input.bodyPath
        ? ['--body-file', input.bodyPath]
        : ['--body', input.body];
      const branchSetupCommand = localBranchExists(
        options.repoPath,
        env,
        input.branch,
      )
        ? null
        : ['git', 'branch', input.branch];
      const dirtyWorktree = hasCommittableChanges(options.repoPath, env);
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
      const commands: string[][] = [
        ...(branchSetupCommand ? [branchSetupCommand] : []),
        ['git', 'push', '-u', 'origin', input.branch],
        prCreateCommand,
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

      const gateway = options.gateway ?? createCommandGateway();
      const policy = createDeliveryCommandPolicy(options.repoPath);
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
  const env = { ...process.env, ...(options.env ?? {}) };
  const remoteName = runReadCommand('git', ['remote'], options.repoPath, env)
    ?.split(/\r?\n/u)
    .find(Boolean);
  const remoteUrl = remoteName
    ? runReadCommand(
        'git',
        ['remote', 'get-url', remoteName],
        options.repoPath,
        env,
      )
    : undefined;
  const currentBranch =
    runReadCommand(
      'git',
      ['branch', '--show-current'],
      options.repoPath,
      env,
    ) ??
    runReadCommand(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      options.repoPath,
      env,
    );
  const dirty =
    (
      runReadCommand('git', ['status', '--short'], options.repoPath, env) ?? ''
    ).trim().length > 0;
  const auth = runStatusCommand(
    'gh',
    ['auth', 'status'],
    options.repoPath,
    env,
  );
  const branchPushed =
    remoteName && branch
      ? runExitCodeCommand(
          'git',
          ['ls-remote', '--exit-code', '--heads', remoteName, branch],
          options.repoPath,
          env,
        ) === 0
      : false;

  return {
    hasRemote: Boolean(remoteName),
    remoteName,
    remoteUrl,
    currentBranch,
    dirty,
    ghAuthenticated: auth.ok,
    branchPushed: Boolean(branchPushed),
    pushRequiresHumanApproval: true,
    prRequiresHumanApproval: true,
    authError: auth.error,
  };
}

function createDeliveryCommandPolicy(repoPath: string): CommandPolicy {
  return {
    allow: [
      { tool: 'git', args: ['checkout'] },
      { tool: 'git', args: ['branch'] },
      { tool: 'git', args: ['add'] },
      { tool: 'git', args: ['commit'] },
      { tool: 'git', args: ['push'] },
      { tool: 'gh', args: ['pr', 'create'] },
      { tool: 'gh', args: ['pr', 'view'] },
    ],
    deny: [{ tool: 'git', args: ['push', '--force'] }],
    requiresHumanApproval: [],
    cwdScope: [repoPath],
    network: 'enabled',
  };
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
    policy: input.policy,
  });

  if (result.status !== 'executed') {
    const detail =
      result.status === 'rejected' ? result.reason : result.decisionId;
    throw new Error(`delivery command ${result.status}: ${detail}`);
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

function localBranchExists(
  repoPath: string,
  env: NodeJS.ProcessEnv,
  branch: string,
): boolean {
  return (
    runExitCodeCommand(
      'git',
      ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`],
      repoPath,
      env,
    ) === 0
  );
}

function hasCommittableChanges(
  repoPath: string,
  env: NodeJS.ProcessEnv,
): boolean {
  const status =
    runReadCommand('git', ['status', '--porcelain'], repoPath, env) ?? '';
  return status
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .some((line) => !line.startsWith('?? .tekon/'));
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

function runReadCommand(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): string | undefined {
  try {
    const output = execFileSync(tool, args, {
      cwd,
      encoding: 'utf8',
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    return output.length > 0 ? output : undefined;
  } catch {
    return undefined;
  }
}

function runStatusCommand(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): { ok: boolean; error?: string } {
  try {
    execFileSync(tool, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function runExitCodeCommand(
  tool: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): number {
  try {
    execFileSync(tool, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return 0;
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'status' in error &&
      typeof error.status === 'number'
    ) {
      return error.status;
    }
    return 1;
  }
}
