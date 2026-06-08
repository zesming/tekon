import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { AuditLogger } from '../audit/logger.js';
import type { DonkeyRepositories } from '../db/repositories.js';
import {
  evaluateWorkReadiness,
  type WorkReadinessEvaluation,
} from '../eval/work-readiness.js';
import { loadRepoProfile } from '../repo/profile.js';
import { readRepoTextPreview } from '../repo/safe-path.js';
import type { Artifact, GateResult } from '../types/domain.js';

export interface TextPreview {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}

export interface ReviewArtifact extends Artifact {
  content: TextPreview;
}

export interface ReviewGate extends GateResult {
  output: TextPreview | null;
}

export interface ReviewDiffSummary {
  branch: string;
  baseBranch: string;
  available: boolean;
  stat: string;
  changedFiles: string[];
  reason?: string;
}

export interface ReviewDeliverySurface {
  status: string;
  prUrl: string | null;
  package: TextPreview | null;
  prBody: TextPreview | null;
  diff: ReviewDiffSummary;
}

export interface WorkReviewSurface {
  runId: string;
  workflowStatus: string;
  demand: {
    id: string;
    title: string;
    body: string;
  };
  readiness: WorkReadinessEvaluation;
  artifacts: ReviewArtifact[];
  gates: ReviewGate[];
  delivery: ReviewDeliverySurface;
  nextCommands: string[];
}

export async function createWorkReviewSurface(input: {
  repoPath: string;
  repositories: DonkeyRepositories;
  audit: AuditLogger;
  runId: string;
  maxContentChars?: number;
}): Promise<WorkReviewSurface> {
  const workflow = await input.repositories.getWorkflowInstance(input.runId);
  if (!workflow) {
    throw new Error(`run not found: ${input.runId}`);
  }
  const demand = await input.repositories.getDemand(workflow.demandId);
  if (!demand) {
    throw new Error(`demand not found: ${workflow.demandId}`);
  }

  const maxContentChars = normalizeMaxContentChars(input.maxContentChars);
  const [readiness, artifacts, gates, deliveryPr] = await Promise.all([
    evaluateWorkReadiness({
      repositories: input.repositories,
      audit: input.audit,
      runId: input.runId,
      repoPath: input.repoPath,
    }),
    input.repositories.listArtifacts(input.runId),
    input.repositories.listGateResults(input.runId),
    input.repositories.getDeliveryPullRequest(input.runId),
  ]);

  const deliveryPaths = deliveryPathsForRun(input.repoPath, input.runId);
  const delivery = {
    status: deliveryPr?.status ?? 'not-prepared',
    prUrl: deliveryPr?.prUrl ?? null,
    package: readOptionalPreview({
      repoPath: input.repoPath,
      path: deliveryPaths.packagePath,
      maxContentChars,
    }),
    prBody: readOptionalPreview({
      repoPath: input.repoPath,
      path: deliveryPr?.bodyPath ?? deliveryPaths.prBodyPath,
      maxContentChars,
    }),
    diff: createDiffSummary({
      repoPath: input.repoPath,
      runId: input.runId,
      branch: deliveryPr?.branch,
      baseBranch: deliveryPr?.baseBranch,
    }),
  } satisfies ReviewDeliverySurface;

  return {
    runId: input.runId,
    workflowStatus: workflow.status,
    demand: {
      id: demand.id,
      title: demand.title,
      body: demand.body,
    },
    readiness,
    artifacts: artifacts.map((artifact) => ({
      ...artifact,
      content: readPreview({
        repoPath: input.repoPath,
        path: artifact.path,
        maxContentChars,
      }),
    })),
    gates: gates.map((gate) => ({
      ...gate,
      output: gate.outputPath
        ? readPreview({
            repoPath: input.repoPath,
            path: gate.outputPath,
            maxContentChars,
          })
        : null,
    })),
    delivery,
    nextCommands: nextCommandsFor({
      runId: input.runId,
      readiness,
      deliveryStatus: delivery.status,
      diffAvailable: delivery.diff.available,
    }),
  };
}

function deliveryPathsForRun(repoPath: string, runId: string) {
  return {
    packagePath: join(
      repoPath,
      '.donkey',
      'runs',
      runId,
      'delivery',
      'pr-package.md',
    ),
    prBodyPath: join(
      repoPath,
      '.donkey',
      'runs',
      runId,
      'delivery',
      'pr-body.md',
    ),
  };
}

function readOptionalPreview(input: {
  repoPath: string;
  path: string;
  maxContentChars: number;
}): TextPreview | null {
  const preview = readPreview(input);
  return preview.exists ? preview : null;
}

function readPreview(input: {
  repoPath: string;
  path: string;
  maxContentChars: number;
}): TextPreview {
  return readRepoTextPreview(input);
}

function normalizeMaxContentChars(value: number | undefined): number {
  if (!value || !Number.isFinite(value) || value <= 0) {
    return 4_000;
  }
  return Math.min(Math.floor(value), 20_000);
}

function createDiffSummary(input: {
  repoPath: string;
  runId: string;
  branch?: string | null;
  baseBranch?: string | null;
}): ReviewDiffSummary {
  const branch = input.branch ?? `donkey-delivery/${input.runId}`;
  const baseBranch = input.baseBranch ?? baseBranchForRepo(input.repoPath);
  const branchCommit = resolveCommit(input.repoPath, branch);
  if (!branchCommit) {
    return {
      branch,
      baseBranch,
      available: false,
      stat: '',
      changedFiles: [],
      reason: `branch ref is missing or unsafe: ${branch}`,
    };
  }

  const baseCommit = resolveCommit(input.repoPath, baseBranch);
  if (!baseCommit) {
    return {
      branch,
      baseBranch,
      available: false,
      stat: '',
      changedFiles: [],
      reason: `base ref is missing or unsafe: ${baseBranch}`,
    };
  }

  const diffRange = `${baseCommit}...${branchCommit}`;
  try {
    return {
      branch,
      baseBranch,
      available: true,
      stat: git(input.repoPath, [
        'diff',
        '--no-ext-diff',
        '--stat',
        diffRange,
      ]).trim(),
      changedFiles: git(input.repoPath, [
        'diff',
        '--no-ext-diff',
        '--name-status',
        diffRange,
      ])
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean),
    };
  } catch (error) {
    return {
      branch,
      baseBranch,
      available: false,
      stat: '',
      changedFiles: [],
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

function baseBranchForRepo(repoPath: string): string {
  try {
    return loadRepoProfile(repoPath).pr.baseBranch;
  } catch {
    return 'HEAD';
  }
}

function resolveCommit(repoPath: string, ref: string): string | null {
  if (!isSafeGitRef(ref)) {
    return null;
  }
  try {
    return git(repoPath, [
      'rev-parse',
      '--verify',
      '--quiet',
      '--end-of-options',
      `${ref}^{commit}`,
    ]).trim();
  } catch {
    return null;
  }
}

function isSafeGitRef(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 240 &&
    !ref.startsWith('-') &&
    !/[\s\0\\:*?[~^]/u.test(ref) &&
    !ref.includes('..') &&
    !ref.includes('@{')
  );
}

function git(repoPath: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function nextCommandsFor(input: {
  runId: string;
  readiness: WorkReadinessEvaluation;
  deliveryStatus: string;
  diffAvailable: boolean;
}): string[] {
  const commands = [
    `donkey status --run-id ${input.runId}`,
    `donkey eval readiness --run-id ${input.runId}`,
  ];
  if (input.deliveryStatus === 'not-prepared') {
    commands.push(`donkey delivery prepare --run-id ${input.runId}`);
  }
  if (!input.readiness.ready) {
    commands.push(`donkey log --run-id ${input.runId}`);
  }
  if (
    input.readiness.ready &&
    input.deliveryStatus !== 'created' &&
    input.diffAvailable
  ) {
    commands.push(
      `donkey delivery create-pr --run-id ${input.runId} --approve-human`,
    );
  }
  return commands;
}
