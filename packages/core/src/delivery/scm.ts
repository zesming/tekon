import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import {
  createCommandGateway,
  type CommandGateway,
  type CommandGatewayResult,
} from '../runtime/command-gateway.js';
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
    title: string;
    body: string;
    branch: string;
    dryRun: boolean;
    humanApproved?: boolean;
  }): Promise<ScmDeliveryCommandResult>;
}

export interface CreateScmDeliveryOptions {
  repoPath: string;
  env?: NodeJS.ProcessEnv;
  gateway?: CommandGateway;
  outputDir?: string;
}

export function createScmDelivery(options: CreateScmDeliveryOptions): ScmDelivery {
  return {
    async getStatus(input) {
      return getScmStatus(options, input?.branch);
    },

    async createPr(input) {
      const commands: string[][] = [
        ['git', 'checkout', '-B', input.branch],
        ['git', 'add', '.'],
        ['git', 'commit', '-m', input.title],
        ['git', 'push', '-u', 'origin', input.branch],
        [
          'gh',
          'pr',
          'create',
          '--title',
          input.title,
          '--body',
          input.body,
          '--head',
          input.branch,
        ],
      ];
      const status = await getScmStatus(options, input.branch);

      if (input.dryRun) {
        return {
          dryRun: true,
          requiresHumanApproval: true,
          commands,
          status,
        };
      }

      if (!input.humanApproved) {
        return {
          dryRun: false,
          requiresHumanApproval: true,
          commands,
          status,
        };
      }

      const gateway = options.gateway ?? createCommandGateway();
      const policy = createDeliveryCommandPolicy(options.repoPath);
      for (const command of commands.slice(0, -1)) {
        await runDeliveryCommand({
          gateway,
          command: toInvocation(command),
          options,
          policy,
        });
      }
      const prResult = await runDeliveryCommand({
        gateway,
        command: toInvocation(commands.at(-1)!),
        options,
        policy,
      });
      const prUrl = readLastOutputLine(prResult.stdoutPath);

      return {
        dryRun: false,
        requiresHumanApproval: false,
        commands,
        status,
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
    runReadCommand('git', ['branch', '--show-current'], options.repoPath, env) ??
    runReadCommand(
      'git',
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      options.repoPath,
      env,
    );
  const dirty =
    (runReadCommand('git', ['status', '--short'], options.repoPath, env) ?? '')
      .trim().length > 0;
  const auth = runStatusCommand('gh', ['auth', 'status'], options.repoPath, env);
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
      { tool: 'git', args: ['add'] },
      { tool: 'git', args: ['commit'] },
      { tool: 'git', args: ['push'] },
      { tool: 'gh', args: ['pr', 'create'] },
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
