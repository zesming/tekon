import { readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';

import { createArtifactStore } from '../artifact/store.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  createCommandGateway,
  type CommandGateway,
  type CommandGatewayResult,
} from '../runtime/command-gateway.js';
import type { CommandPolicy } from '../types/config.js';
import type { Artifact } from '../types/domain.js';

export type PullRequestCiStatus =
  | 'passed'
  | 'failed'
  | 'pending'
  | 'skipped'
  | 'unknown';

export interface PullRequestCiCheck {
  name: string;
  state?: string;
  bucket?: string;
  workflow?: string;
  link?: string;
  description?: string;
}

export interface PullRequestCiReport {
  runId: string;
  selector: string;
  prUrl?: string;
  status: PullRequestCiStatus;
  checkedAt: string;
  checks: PullRequestCiCheck[];
  artifact: Artifact;
}

export interface PullRequestCiWatchResult {
  runId: string;
  selector: string;
  finalStatus: PullRequestCiStatus;
  terminal: boolean;
  attempts: number;
  maxAttempts: number;
  reports: PullRequestCiReport[];
  finalReport: PullRequestCiReport;
}

export async function queryPullRequestCiStatus(input: {
  repoPath: string;
  runId: string;
  repositories: TekonRepositories;
  audit?: AuditLogger;
  gateway?: CommandGateway;
  env?: NodeJS.ProcessEnv;
  outputDir?: string;
  selector?: string;
  maxContentChars?: number;
}): Promise<PullRequestCiReport> {
  const runSegment = assertSafePathSegment(input.runId);
  const workflow = await input.repositories.getWorkflowInstance(input.runId);
  if (!workflow) {
    throw new Error(`run not found: ${input.runId}`);
  }
  const delivery = await input.repositories.getDeliveryPullRequest(input.runId);
  const selector = input.selector ?? delivery?.prUrl ?? delivery?.branch;
  if (!selector) {
    throw new Error(`run has no PR selector for CI status: ${input.runId}`);
  }
  const outputDir = input.outputDir
    ? assertManagedOutputDir(input.repoPath, input.outputDir)
    : join(input.repoPath, '.tekon', 'runs', runSegment, 'delivery', 'ci');

  const result = await (input.gateway ?? createCommandGateway()).run({
    command: {
      tool: 'gh',
      args: [
        'pr',
        'checks',
        selector,
        '--json',
        'bucket,completedAt,description,event,link,name,startedAt,state,workflow',
      ],
    },
    cwd: input.repoPath,
    env: input.env,
    envMode: input.env ? 'inherit' : 'safe-default',
    outputDir,
    policy: createCiCommandPolicy(input.repoPath),
  });

  const checks = parseCiChecks(result);
  const status = summarizeCiStatus(checks);
  const checkedAt = new Date().toISOString();
  const artifact = await writeCiStatusArtifact({
    repoPath: input.repoPath,
    repositories: input.repositories,
    runId: input.runId,
    prUrl: delivery?.prUrl ?? undefined,
    selector,
    status,
    checkedAt,
    checks,
  });

  await input.audit?.append({
    runId: input.runId,
    type: 'delivery.ci.checked',
    payload: {
      selector,
      prUrl: delivery?.prUrl ?? null,
      status,
      checks: checks.length,
      artifactId: artifact.id,
    },
  });

  return {
    runId: input.runId,
    selector,
    prUrl: delivery?.prUrl ?? undefined,
    status,
    checkedAt,
    checks,
    artifact,
  };
}

export async function watchPullRequestCiStatus(input: {
  repoPath: string;
  runId: string;
  repositories: TekonRepositories;
  audit?: AuditLogger;
  gateway?: CommandGateway;
  env?: NodeJS.ProcessEnv;
  outputDir?: string;
  selector?: string;
  maxContentChars?: number;
  maxAttempts?: number;
  intervalMs?: number;
  backoffMultiplier?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<PullRequestCiWatchResult> {
  const maxAttempts = normalizeMaxAttempts(input.maxAttempts);
  const intervalMs = normalizeIntervalMs(input.intervalMs);
  const backoffMultiplier = normalizeBackoff(input.backoffMultiplier);
  const sleep = input.sleep ?? defaultSleep;
  const reports: PullRequestCiReport[] = [];
  let delayMs = intervalMs;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const report = await queryPullRequestCiStatus(input);
    reports.push(report);
    if (isTerminalCiStatus(report.status) || attempt === maxAttempts) {
      const terminal = isTerminalCiStatus(report.status);
      await input.audit?.append({
        runId: input.runId,
        type: 'delivery.ci.watch-completed',
        payload: {
          selector: report.selector,
          status: report.status,
          attempts: reports.length,
          maxAttempts,
          terminal,
          artifactId: report.artifact.id,
        },
      });
      return {
        runId: input.runId,
        selector: report.selector,
        finalStatus: report.status,
        terminal,
        attempts: reports.length,
        maxAttempts,
        reports,
        finalReport: report,
      };
    }
    await sleep(delayMs);
    delayMs = Math.ceil(delayMs * backoffMultiplier);
  }

  throw new Error('unreachable CI watch state');
}

function parseCiChecks(result: CommandGatewayResult): PullRequestCiCheck[] {
  if (result.status !== 'executed') {
    const detail =
      result.status === 'rejected' ? result.reason : result.decisionId;
    throw new Error(`CI status command ${result.status}: ${detail}`);
  }

  const raw = readFileSync(result.stdoutPath, 'utf8').trim();
  if (!raw && result.exitCode !== 0) {
    throw new Error(
      `CI status command failed with exit code ${result.exitCode}`,
    );
  }
  if (!raw) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    if (result.exitCode !== 0) {
      throw new Error(
        `CI status command failed with exit code ${result.exitCode}`,
      );
    }
    throw error;
  }
  if (!Array.isArray(parsed)) {
    throw new Error('gh pr checks JSON output must be an array');
  }
  return parsed.map(normalizeCiCheck);
}

function isTerminalCiStatus(status: PullRequestCiStatus): boolean {
  return ['passed', 'failed', 'skipped'].includes(status);
}

function normalizeMaxAttempts(value: number | undefined): number {
  if (value === undefined) {
    return 20;
  }
  if (!Number.isInteger(value) || value < 1 || value > 200) {
    throw new Error('--max-attempts must be an integer between 1 and 200');
  }
  return value;
}

function normalizeIntervalMs(value: number | undefined): number {
  if (value === undefined) {
    return 15_000;
  }
  if (!Number.isFinite(value) || value < 0 || value > 3_600_000) {
    throw new Error('--interval-ms must be between 0 and 3600000');
  }
  return Math.floor(value);
}

function normalizeBackoff(value: number | undefined): number {
  if (value === undefined) {
    return 1;
  }
  if (!Number.isFinite(value) || value < 1 || value > 10) {
    throw new Error('--backoff must be between 1 and 10');
  }
  return value;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, ms);
  });
}

function normalizeCiCheck(value: unknown): PullRequestCiCheck {
  const entry =
    value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : {};
  const name = stringField(entry.name) ?? 'unnamed check';
  return {
    name,
    state: stringField(entry.state),
    bucket: stringField(entry.bucket),
    workflow: stringField(entry.workflow),
    link: stringField(entry.link),
    description: stringField(entry.description),
  };
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function summarizeCiStatus(checks: PullRequestCiCheck[]): PullRequestCiStatus {
  if (checks.length === 0) {
    return 'unknown';
  }
  const buckets = checks.map((check) =>
    (check.bucket ?? check.state ?? '').toLowerCase(),
  );
  if (
    buckets.some((bucket) =>
      ['fail', 'failed', 'failure', 'error', 'cancel', 'cancelled'].includes(
        bucket,
      ),
    )
  ) {
    return 'failed';
  }
  if (
    buckets.some((bucket) =>
      ['pending', 'queued', 'in_progress', 'waiting', 'requested'].includes(
        bucket,
      ),
    )
  ) {
    return 'pending';
  }
  if (
    buckets.every((bucket) => ['skip', 'skipped', 'skipping'].includes(bucket))
  ) {
    return 'skipped';
  }
  if (
    buckets.every((bucket) =>
      ['pass', 'passed', 'success', 'successful', 'skip', 'skipped'].includes(
        bucket,
      ),
    )
  ) {
    return 'passed';
  }
  return 'unknown';
}

async function writeCiStatusArtifact(input: {
  repoPath: string;
  repositories: TekonRepositories;
  runId: string;
  selector: string;
  prUrl?: string;
  status: PullRequestCiStatus;
  checkedAt: string;
  checks: PullRequestCiCheck[];
}): Promise<Artifact> {
  const nodes = await input.repositories.listNodes(input.runId);
  const deliveryNode = nodes.at(-1);
  if (!deliveryNode) {
    throw new Error(`run has no nodes: ${input.runId}`);
  }
  const content = JSON.stringify(
    {
      title: `CI status for ${input.selector}`,
      summary: `Remote CI status is ${input.status}`,
      body: formatCiBody(input),
      ciStatus: input.status,
      prUrl: input.prUrl,
      checkedAt: input.checkedAt,
      checks: input.checks,
    },
    null,
    2,
  );
  return createArtifactStore({
    repoPath: input.repoPath,
    repositories: input.repositories,
  }).writeArtifact({
    runId: input.runId,
    nodeId: deliveryNode.id,
    type: 'ci-status',
    content,
    summary: `Remote CI status is ${input.status}`,
  });
}

function formatCiBody(input: {
  status: PullRequestCiStatus;
  checkedAt: string;
  selector: string;
  prUrl?: string;
  checks: PullRequestCiCheck[];
}): string {
  return [
    `status: ${input.status}`,
    `checkedAt: ${input.checkedAt}`,
    `selector: ${input.selector}`,
    `prUrl: ${input.prUrl ?? 'none'}`,
    'checks:',
    ...(input.checks.length
      ? input.checks.map(
          (check) =>
            `- ${check.name}: ${check.bucket ?? check.state ?? 'unknown'}`,
        )
      : ['- none']),
  ].join('\n');
}

function createCiCommandPolicy(repoPath: string): CommandPolicy {
  return {
    allow: [{ tool: 'gh', args: ['pr', 'checks'] }],
    deny: [],
    requiresHumanApproval: [],
    cwdScope: [repoPath],
    network: 'enabled',
  };
}

function assertSafePathSegment(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/u.test(value)) {
    throw new Error(`unsafe path segment: ${value}`);
  }
  return value;
}

function assertManagedOutputDir(repoPath: string, outputDir: string): string {
  const root = resolve(repoPath, '.tekon');
  const target = isAbsolute(outputDir)
    ? resolve(outputDir)
    : resolve(repoPath, outputDir);
  if (target !== root && !target.startsWith(`${root}${sep}`)) {
    throw new Error(`CI outputDir escapes .tekon: ${outputDir}`);
  }
  return target;
}
