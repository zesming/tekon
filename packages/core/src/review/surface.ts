import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
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

export type ReviewGateRetryRecommendation =
  | 'after-fix'
  | 'after-approval'
  | 'not-recommended';

export interface ReviewGateFailureTriage {
  gateId: string;
  nodeId: string;
  gateType: GateResult['gateType'];
  status: GateResult['status'];
  classification: string;
  retry: ReviewGateRetryRecommendation;
  summary: string;
  suggestedCommand: string;
  logHref: string;
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
  gateFailureTriage: ReviewGateFailureTriage[];
  delivery: ReviewDeliverySurface;
  evidenceGroups: ReviewEvidenceGroup[];
  nextCommands: string[];
}

export type ReviewCommandDisplay = 'default' | 'explicit';

export async function createWorkReviewSurface(input: {
  repoPath: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  runId: string;
  maxContentChars?: number;
  commandDisplay?: ReviewCommandDisplay;
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
    gateFailureTriage: createGateFailureTriage({
      repoPath: input.repoPath,
      runId: input.runId,
      gates,
      commandDisplay: input.commandDisplay,
    }),
    delivery,
    evidenceGroups: createEvidenceGroups({
      readiness,
      artifacts,
      gates,
      delivery,
      auditEvents,
    }),
    nextCommands: nextCommandsFor({
      repoPath: input.repoPath,
      runId: input.runId,
      readiness,
      deliveryStatus: delivery.status,
      diffAvailable: delivery.diff.available,
      commandDisplay: input.commandDisplay,
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

function createGateFailureTriage(input: {
  repoPath: string;
  runId: string;
  gates: GateResult[];
  commandDisplay?: ReviewCommandDisplay;
}): ReviewGateFailureTriage[] {
  return input.gates
    .filter((gate) => shouldTriageGate(gate))
    .map((gate) => {
      const classification = classifyGateFailure(gate);
      const advice = gateTriageAdvice({
        repoPath: input.repoPath,
        runId: input.runId,
        gate,
        classification,
        commandDisplay: input.commandDisplay,
      });
      return {
        gateId: gate.id,
        nodeId: gate.nodeId,
        gateType: gate.gateType,
        status: gate.status,
        classification,
        retry: advice.retry,
        summary: advice.summary,
        suggestedCommand: advice.suggestedCommand,
        logHref: `#gate-log-${gate.id}`,
      };
    });
}

function shouldTriageGate(gate: GateResult): boolean {
  if (gate.status === 'failed' || gate.status === 'blocked') {
    return true;
  }
  return (
    gate.status === 'skipped' &&
    gate.failureClassification !== undefined &&
    gate.failureClassification !== null &&
    gate.failureClassification !== 'not-applicable'
  );
}

function classifyGateFailure(gate: GateResult): string {
  if (gate.gateType === 'human' && gate.status === 'blocked') {
    return gate.failureClassification ?? 'human-approval';
  }
  return (
    gate.failureClassification ??
    (gate.status === 'blocked' ? 'blocked' : 'unknown')
  );
}

function gateTriageAdvice(input: {
  repoPath: string;
  runId: string;
  gate: GateResult;
  classification: string;
  commandDisplay?: ReviewCommandDisplay;
}): {
  retry: ReviewGateRetryRecommendation;
  summary: string;
  suggestedCommand: string;
} {
  const explicitSuffix =
    input.commandDisplay === 'explicit'
      ? ` --run-id ${quoteCliArg(input.runId)} --repo ${quoteCliArg(input.repoPath)}`
      : '';
  const logCommand =
    input.commandDisplay === 'explicit'
      ? `tekon log${explicitSuffix}`
      : 'tekon log';
  const reviewCommand =
    input.commandDisplay === 'explicit'
      ? `tekon review${explicitSuffix}`
      : 'tekon review';
  if (isHumanApprovalTriage(input.gate, input.classification)) {
    return {
      retry: 'after-approval',
      summary:
        'Human approval is required before this gate can continue. Approve only after reviewing the pending decision and risk.',
      suggestedCommand:
        input.commandDisplay === 'explicit'
          ? `tekon resume --run-id ${quoteCliArg(input.runId)} --approve-human --repo ${quoteCliArg(input.repoPath)}`
          : 'tekon resume --approve-human',
    };
  }
  if (input.classification === 'missing-command') {
    return {
      retry: 'after-fix',
      summary:
        'Gate command is missing from repo profile. Resolve the commandRef before retrying this run.',
      suggestedCommand:
        input.commandDisplay === 'explicit'
          ? `tekon workflow preflight <template> --repo ${quoteCliArg(input.repoPath)}`
          : 'tekon workflow preflight <template>',
    };
  }
  if (input.classification === 'security-findings') {
    return {
      retry: 'after-fix',
      summary:
        'Security scan found sensitive material or unsafe output. Inspect the gate log and remove the finding before retrying.',
      suggestedCommand: reviewCommand,
    };
  }
  if (
    ['missing-artifact-type', 'missing-artifact', 'invalid-artifact'].includes(
      input.classification,
    )
  ) {
    return {
      retry: 'after-fix',
      summary:
        'Provider artifact output is incomplete or invalid. Fix the manifest/schema output before retrying.',
      suggestedCommand: reviewCommand,
    };
  }
  if (input.classification === 'timeout') {
    return {
      retry: 'after-fix',
      summary:
        'Gate command timed out. Inspect logs, adjust the command or timeout, then retry.',
      suggestedCommand: logCommand,
    };
  }
  if (input.classification === 'rejected') {
    return {
      retry: 'not-recommended',
      summary:
        'Command policy rejected this gate command. Change the command or policy intentionally before retrying.',
      suggestedCommand: reviewCommand,
    };
  }
  if (input.classification === 'human-rejected') {
    return {
      retry: 'not-recommended',
      summary:
        'A human reviewer rejected this gate. Review the rejection note and change the work before starting a new run or retrying.',
      suggestedCommand: reviewCommand,
    };
  }
  if (input.classification === 'unsupported-gate') {
    return {
      retry: 'not-recommended',
      summary:
        'Workflow references a gate type Tekon does not support in the current runtime.',
      suggestedCommand: reviewCommand,
    };
  }
  if (input.classification === 'exit-code') {
    return {
      retry: 'after-fix',
      summary: `${input.gate.gateType} command exited non-zero. Inspect the gate log, fix the failure, then retry.`,
      suggestedCommand: logCommand,
    };
  }
  return {
    retry: 'after-fix',
    summary:
      'Gate did not pass. Inspect the linked gate log and audit trail before retrying.',
    suggestedCommand: logCommand,
  };
}

function isHumanApprovalTriage(
  gate: GateResult,
  classification: string,
): boolean {
  return (
    classification === 'blocked-for-approval' ||
    classification === 'human-approval' ||
    (gate.gateType === 'human' && gate.status === 'blocked')
  );
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
      '.tekon',
      'runs',
      runId,
      'delivery',
      'pr-package.md',
    ),
    prBodyPath: join(
      repoPath,
      '.tekon',
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
  const branch = input.branch ?? `tekon-delivery/${input.runId}`;
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
  repoPath: string;
  runId: string;
  readiness: WorkReadinessEvaluation;
  deliveryStatus: string;
  diffAvailable: boolean;
  commandDisplay?: ReviewCommandDisplay;
}): string[] {
  const runFlag =
    input.commandDisplay === 'explicit'
      ? ` --run-id ${quoteCliArg(input.runId)} --repo ${quoteCliArg(input.repoPath)}`
      : '';
  const commands = [`tekon status${runFlag}`, `tekon eval readiness${runFlag}`];
  if (input.deliveryStatus === 'not-prepared') {
    commands.push(`tekon delivery prepare${runFlag}`);
  }
  if (!input.readiness.ready) {
    commands.push(`tekon log${runFlag}`);
  }
  if (
    input.readiness.ready &&
    input.deliveryStatus !== 'created' &&
    input.diffAvailable
  ) {
    commands.push(`tekon delivery create-pr${runFlag} --approve-human`);
  }
  return commands;
}

function quoteCliArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
