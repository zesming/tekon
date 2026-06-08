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
import type { Artifact, AuditEvent, GateResult } from '../types/domain.js';

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

export type ReviewEvidenceLinkKind =
  | 'artifact'
  | 'gate-log'
  | 'audit-event'
  | 'pr-body'
  | 'pr-package'
  | 'diff';

export interface ReviewEvidenceLink {
  kind: ReviewEvidenceLinkKind;
  label: string;
  href: string;
  summary: string;
}

export interface ReviewEvidenceGroup {
  id: string;
  title: string;
  status: 'failed' | 'warning' | 'info';
  severity: 'required' | 'recommended' | 'context';
  summary: string;
  links: ReviewEvidenceLink[];
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
  evidenceGroups: ReviewEvidenceGroup[];
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
  const [readiness, artifacts, gates, deliveryPr, auditEvents] =
    await Promise.all([
      evaluateWorkReadiness({
        repositories: input.repositories,
        audit: input.audit,
        runId: input.runId,
        repoPath: input.repoPath,
      }),
      input.repositories.listArtifacts(input.runId),
      input.repositories.listGateResults(input.runId),
      input.repositories.getDeliveryPullRequest(input.runId),
      input.repositories.listAuditEvents(input.runId),
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
    evidenceGroups: createEvidenceGroups({
      readiness,
      artifacts,
      gates,
      delivery,
      auditEvents,
    }),
    nextCommands: nextCommandsFor({
      runId: input.runId,
      readiness,
      deliveryStatus: delivery.status,
      diffAvailable: delivery.diff.available,
    }),
  };
}

function createEvidenceGroups(input: {
  readiness: WorkReadinessEvaluation;
  artifacts: Artifact[];
  gates: GateResult[];
  delivery: ReviewDeliverySurface;
  auditEvents: AuditEvent[];
}): ReviewEvidenceGroup[] {
  const groups: ReviewEvidenceGroup[] = [
    {
      id: 'review-route',
      title: 'Review Route',
      status: 'info',
      severity: 'context',
      summary:
        'Start from PR package and diff, then inspect failed gates/artifacts and matching audit events.',
      links: compactLinks([
        input.delivery.package ? linkPrPackage(input.delivery.package) : null,
        input.delivery.prBody ? linkPrBody(input.delivery.prBody) : null,
        input.delivery.diff.available ? linkDiff(input.delivery.diff) : null,
        ...input.gates.filter((gate) => gate.status !== 'passed').map(linkGate),
        ...input.auditEvents.slice(-3).map(linkAuditEvent),
      ]),
    },
  ];

  for (const check of input.readiness.checks.filter((item) => !item.passed)) {
    const links = linksForReadinessCheck({
      checkId: check.id,
      artifacts: input.artifacts,
      gates: input.gates,
      delivery: input.delivery,
      auditEvents: input.auditEvents,
    });
    groups.push({
      id: `readiness-${check.id}`,
      title: `Readiness: ${check.id}`,
      status: check.severity === 'required' ? 'failed' : 'warning',
      severity: check.severity,
      summary: check.evidence,
      links,
    });
  }

  return groups;
}

function linksForReadinessCheck(input: {
  checkId: string;
  artifacts: Artifact[];
  gates: GateResult[];
  delivery: ReviewDeliverySurface;
  auditEvents: AuditEvent[];
}): ReviewEvidenceLink[] {
  const deliveryAuditEvents = input.auditEvents.filter((event) =>
    event.type.startsWith('delivery.'),
  );
  const linksByCheck: Record<string, Array<ReviewEvidenceLink | null>> = {
    'workflow-passed': input.auditEvents
      .filter((event) => event.type.startsWith('run.'))
      .map(linkAuditEvent),
    'audit-valid': input.auditEvents.slice(-5).map(linkAuditEvent),
    'validation-gates-passed': [
      ...input.gates
        .filter(
          (gate) =>
            ['build', 'test', 'lint', 'e2e-pass'].includes(gate.gateType) &&
            gate.status !== 'passed' &&
            !(
              gate.status === 'skipped' &&
              gate.failureClassification === 'not-applicable'
            ),
        )
        .map(linkGate),
      ...auditEventsForGates(input.auditEvents, input.gates).map(
        linkAuditEvent,
      ),
    ],
    'delivery-package-present': [
      ...input.artifacts
        .filter((artifact) => artifact.type === 'delivery-package')
        .map(linkArtifact),
      input.delivery.package ? linkPrPackage(input.delivery.package) : null,
      ...deliveryAuditEvents.map(linkAuditEvent),
    ],
    'pr-prepared': [
      input.delivery.package ? linkPrPackage(input.delivery.package) : null,
      input.delivery.prBody ? linkPrBody(input.delivery.prBody) : null,
      ...deliveryAuditEvents.map(linkAuditEvent),
    ],
    'no-pending-human-gates': [
      ...input.gates.filter((gate) => gate.gateType === 'human').map(linkGate),
      ...input.auditEvents
        .filter((event) => event.type.includes('human'))
        .map(linkAuditEvent),
    ],
    'acceptance-criteria-evidenced': [
      ...input.artifacts
        .filter((artifact) =>
          ['prd', 'test-report', 'review-report', 'delivery-package'].includes(
            artifact.type,
          ),
        )
        .map(linkArtifact),
      input.delivery.package ? linkPrPackage(input.delivery.package) : null,
    ],
    'security-scans-passed': [
      ...input.gates
        .filter((gate) => gate.gateType === 'security-scan')
        .map(linkGate),
      ...input.artifacts
        .filter((artifact) => artifact.type === 'security-report')
        .map(linkArtifact),
      ...input.auditEvents
        .filter((event) => event.type.includes('security'))
        .map(linkAuditEvent),
    ],
    'pr-created': [
      input.delivery.prBody ? linkPrBody(input.delivery.prBody) : null,
      input.delivery.package ? linkPrPackage(input.delivery.package) : null,
      ...deliveryAuditEvents.map(linkAuditEvent),
    ],
    'remote-ci-passed': [
      ...input.artifacts
        .filter((artifact) => artifact.type === 'ci-status')
        .map(linkArtifact),
      ...input.auditEvents
        .filter((event) => event.type === 'delivery.ci.checked')
        .map(linkAuditEvent),
      input.delivery.package ? linkPrPackage(input.delivery.package) : null,
    ],
  };

  const links = compactLinks(linksByCheck[input.checkId] ?? []);
  if (links.length > 0) {
    return links;
  }
  return compactLinks([
    input.delivery.package ? linkPrPackage(input.delivery.package) : null,
    ...input.auditEvents.slice(-3).map(linkAuditEvent),
  ]);
}

function linkArtifact(artifact: Artifact): ReviewEvidenceLink {
  return {
    kind: 'artifact',
    label: `${artifact.type} ${artifact.id}`,
    href: `#artifact-${artifact.id}`,
    summary: artifact.summary ?? artifact.path,
  };
}

function linkGate(gate: GateResult): ReviewEvidenceLink {
  return {
    kind: 'gate-log',
    label: `${gate.gateType} ${gate.id}`,
    href: `#gate-log-${gate.id}`,
    summary: `${gate.status}${gate.failureClassification ? ` ${gate.failureClassification}` : ''}`,
  };
}

function linkAuditEvent(event: AuditEvent): ReviewEvidenceLink {
  return {
    kind: 'audit-event',
    label: event.type,
    href: `#audit-${event.id}`,
    summary: `${event.createdAt} hash=${event.hash.slice(0, 12)}`,
  };
}

function linkPrBody(preview: TextPreview): ReviewEvidenceLink {
  return {
    kind: 'pr-body',
    label: 'PR body',
    href: '#pr-body',
    summary: preview.path,
  };
}

function linkPrPackage(preview: TextPreview): ReviewEvidenceLink {
  return {
    kind: 'pr-package',
    label: 'PR package',
    href: '#pr-package',
    summary: preview.path,
  };
}

function linkDiff(diff: ReviewDiffSummary): ReviewEvidenceLink {
  return {
    kind: 'diff',
    label: 'Delivery diff',
    href: '#delivery-diff',
    summary: `${diff.baseBranch}...${diff.branch}`,
  };
}

function auditEventsForGates(
  auditEvents: AuditEvent[],
  gates: GateResult[],
): AuditEvent[] {
  const gateIds = new Set(gates.map((gate) => gate.id));
  return auditEvents.filter((event) => {
    const gateId =
      stringPayload(event, 'gateResultId') ?? stringPayload(event, 'gateId');
    return Boolean(gateId && gateIds.has(gateId));
  });
}

function compactLinks(
  links: Array<ReviewEvidenceLink | null>,
): ReviewEvidenceLink[] {
  const seen = new Set<string>();
  const compacted: ReviewEvidenceLink[] = [];
  for (const link of links) {
    if (!link) {
      continue;
    }
    const key = `${link.kind}:${link.href}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    compacted.push(link);
    if (compacted.length >= 12) {
      break;
    }
  }
  return compacted;
}

function stringPayload(event: AuditEvent, key: string): string | null {
  const value = event.payload[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
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
