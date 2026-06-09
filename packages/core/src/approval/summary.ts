import type { AuditLogger } from '../audit/logger.js';
import type { DonkeyRepositories } from '../db/repositories.js';
import type { WorkReadinessCheck } from '../eval/work-readiness.js';
import type { GateResult, HumanDecision, Node } from '../types/domain.js';
import {
  createWorkReviewSurface,
  type ReviewEvidenceLink,
  type WorkReviewSurface,
} from '../review/surface.js';

export type ApprovalImpactStatus = 'available' | 'none' | 'unavailable';

export interface HumanApprovalSummary {
  decisionId: string;
  decisionStatus: HumanDecision['status'];
  runId: string;
  nodeId: string;
  nodeRole: Node['role'] | null;
  workflowStatus: string;
  demandTitle: string;
  gate: {
    id: string;
    type: GateResult['gateType'];
    status: GateResult['status'];
    failureClassification: string | null;
  } | null;
  riskLabel: string;
  exactCommand: string;
  requestContext: string;
  impact: {
    status: ApprovalImpactStatus;
    files: string[];
    reason: string | null;
  };
  readinessFailed: WorkReadinessCheck[];
  evidenceLinks: ReviewEvidenceLink[];
  approveCommand: string;
  rejectCommand: string;
  webActionHint: string;
  summaryText: string;
}

export interface ApprovalSummaryCheck {
  id: string;
  passed: boolean;
  evidence: string;
}

export interface ApprovalSummaryEvaluation {
  ready: boolean;
  score: number;
  checks: ApprovalSummaryCheck[];
}

export async function createHumanApprovalSummary(input: {
  repoPath: string;
  repositories: DonkeyRepositories;
  audit: AuditLogger;
  runId: string;
  decisionId?: string;
  maxContentChars?: number;
}): Promise<HumanApprovalSummary> {
  const decisions = await input.repositories.listHumanDecisions(input.runId);
  const decision =
    (input.decisionId
      ? decisions.find((item) => item.id === input.decisionId)
      : decisions.find((item) => item.status === 'pending')) ?? null;
  if (!decision) {
    throw new Error(
      input.decisionId
        ? `human decision not found: ${input.decisionId}`
        : `run has no pending human decision: ${input.runId}`,
    );
  }

  const [surface, node, gates] = await Promise.all([
    createWorkReviewSurface({
      repoPath: input.repoPath,
      repositories: input.repositories,
      audit: input.audit,
      runId: input.runId,
      maxContentChars: input.maxContentChars,
    }),
    input.repositories.getNode(decision.nodeId),
    input.repositories.listGateResults(input.runId),
  ]);
  const gate = decision.gateResultId
    ? (gates.find((item) => item.id === decision.gateResultId) ?? null)
    : null;

  return buildHumanApprovalSummary({
    repoPath: input.repoPath,
    decision,
    node,
    gate,
    surface,
  });
}

export function buildHumanApprovalSummary(input: {
  repoPath: string;
  decision: HumanDecision;
  node: Node | null;
  gate: GateResult | null;
  surface: WorkReviewSurface;
}): HumanApprovalSummary {
  const riskLabel = deriveRiskLabel(input.decision.note, input.gate);
  const exactCommand = extractExactCommand(input.decision.note);
  const requestContext =
    input.decision.note?.trim() || 'No request context recorded.';
  const impact = deriveImpact(input.surface);
  const readinessFailed = input.surface.readiness.checks.filter(
    (check) => !check.passed,
  );
  const evidenceLinks = collectEvidenceLinks(input.surface);
  const approveCommand = [
    'donkey',
    'resume',
    '--run-id',
    quoteCliArg(input.decision.runId),
    '--approve-human',
    '--repo',
    quoteCliArg(input.repoPath),
  ].join(' ');
  const rejectCommand = [
    'donkey',
    'approval',
    'reject',
    '--run-id',
    quoteCliArg(input.decision.runId),
    '--decision-id',
    quoteCliArg(input.decision.id),
    '--repo',
    quoteCliArg(input.repoPath),
  ].join(' ');

  const summary: Omit<HumanApprovalSummary, 'summaryText'> = {
    decisionId: input.decision.id,
    decisionStatus: input.decision.status,
    runId: input.decision.runId,
    nodeId: input.decision.nodeId,
    nodeRole: input.node?.role ?? null,
    workflowStatus: input.surface.workflowStatus,
    demandTitle: input.surface.demand.title,
    gate: input.gate
      ? {
          id: input.gate.id,
          type: input.gate.gateType,
          status: input.gate.status,
          failureClassification: input.gate.failureClassification ?? null,
        }
      : null,
    riskLabel,
    exactCommand,
    requestContext,
    impact,
    readinessFailed,
    evidenceLinks,
    approveCommand,
    rejectCommand,
    webActionHint: `Web dashboard -> 待人工审批 -> decision ${input.decision.id}`,
  };

  return {
    ...summary,
    summaryText: renderHumanApprovalSummary(summary),
  };
}

export function evaluateHumanApprovalSummary(
  summary: HumanApprovalSummary,
): ApprovalSummaryEvaluation {
  const checks: ApprovalSummaryCheck[] = [
    {
      id: 'pending-decision-present',
      passed:
        summary.decisionStatus === 'pending' &&
        summary.decisionId.length > 0 &&
        summary.runId.length > 0,
      evidence: `decision=${summary.decisionId} status=${summary.decisionStatus}`,
    },
    {
      id: 'risk-context-present',
      passed: summary.riskLabel.length > 0,
      evidence: `risk=${summary.riskLabel || 'missing'}`,
    },
    {
      id: 'command-context-present',
      passed:
        summary.exactCommand.length > 0 &&
        summary.exactCommand !== 'not recorded',
      evidence: `exactCommand=${summary.exactCommand}`,
    },
    {
      id: 'impact-context-present',
      passed:
        summary.impact.status !== 'unavailable' ||
        Boolean(summary.impact.reason),
      evidence:
        summary.impact.status === 'available'
          ? `${summary.impact.files.length} impact files`
          : `${summary.impact.status}: ${summary.impact.reason ?? 'no reason'}`,
    },
    {
      id: 'approval-entry-present',
      passed:
        isCopyableApprovalCommand(summary.approveCommand, [
          'donkey',
          'resume',
        ]) &&
        summary.approveCommand.includes('--approve-human') &&
        commandHasFlagValues(summary.approveCommand, ['--run-id', '--repo']),
      evidence: summary.approveCommand,
    },
    {
      id: 'rejection-entry-present',
      passed:
        isCopyableApprovalCommand(summary.rejectCommand, [
          'donkey',
          'approval',
          'reject',
        ]) &&
        commandHasFlagValues(summary.rejectCommand, [
          '--run-id',
          '--decision-id',
          '--repo',
        ]) &&
        !commandHasAnyFlag(summary.rejectCommand, ['--actor']),
      evidence: summary.rejectCommand || summary.webActionHint,
    },
    {
      id: 'evidence-context-present',
      passed:
        summary.evidenceLinks.length > 0 ||
        summary.readinessFailed.length > 0 ||
        Boolean(summary.gate),
      evidence: `${summary.evidenceLinks.length} evidence links, ${summary.readinessFailed.length} failed readiness checks`,
    },
    {
      id: 'copyable-summary-present',
      passed:
        summary.summaryText.includes(summary.decisionId) &&
        summary.summaryText.includes(summary.approveCommand) &&
        summary.summaryText.includes(summary.rejectCommand) &&
        summary.summaryText.includes(summary.webActionHint),
      evidence: `${summary.summaryText.length} chars`,
    },
  ];
  const passed = checks.filter((check) => check.passed).length;
  return {
    ready: checks.every((check) => check.passed),
    score: checks.length === 0 ? 0 : passed / checks.length,
    checks,
  };
}

export function renderHumanApprovalSummary(
  summary: Omit<HumanApprovalSummary, 'summaryText'>,
): string {
  const lines = [
    `# Donkey 审批摘要`,
    '',
    `- decisionId: ${summary.decisionId}`,
    `- runId: ${summary.runId}`,
    `- nodeId: ${summary.nodeId}`,
    `- role: ${summary.nodeRole ?? 'unknown'}`,
    `- workflowStatus: ${summary.workflowStatus}`,
    `- demand: ${summary.demandTitle}`,
    `- risk: ${summary.riskLabel}`,
    `- gate: ${
      summary.gate
        ? `${summary.gate.id} ${summary.gate.type} ${summary.gate.status}${
            summary.gate.failureClassification
              ? ` ${summary.gate.failureClassification}`
              : ''
          }`
        : 'not linked'
    }`,
    `- exactCommand: ${summary.exactCommand}`,
    '',
    `## 请求上下文`,
    summary.requestContext,
    '',
    `## 影响文件`,
    ...formatImpact(summary.impact),
    '',
    `## Readiness 失败项`,
    ...(summary.readinessFailed.length === 0
      ? ['- none']
      : summary.readinessFailed.map(
          (check) => `- ${check.id} (${check.severity}): ${check.evidence}`,
        )),
    '',
    `## 证据入口`,
    ...(summary.evidenceLinks.length === 0
      ? ['- none']
      : summary.evidenceLinks.map(
          (link) =>
            `- ${link.kind} ${link.label}: ${link.href} (${link.summary})`,
        )),
    '',
    `## 处理入口`,
    `- Approve: ${summary.approveCommand}`,
    `- Reject: ${summary.rejectCommand}`,
    `- Web: ${summary.webActionHint}`,
  ];
  return `${lines.join('\n')}\n`;
}

function deriveImpact(
  surface: WorkReviewSurface,
): HumanApprovalSummary['impact'] {
  if (surface.delivery.diff.available) {
    return surface.delivery.diff.changedFiles.length > 0
      ? {
          status: 'available',
          files: surface.delivery.diff.changedFiles,
          reason: null,
        }
      : {
          status: 'none',
          files: [],
          reason: 'delivery diff is available but contains no changed files',
        };
  }
  return {
    status: 'unavailable',
    files: [],
    reason: surface.delivery.diff.reason ?? 'delivery diff not available',
  };
}

function formatImpact(impact: HumanApprovalSummary['impact']): string[] {
  if (impact.status === 'available') {
    return impact.files.map((file) => `- ${file}`);
  }
  return [`- ${impact.status}: ${impact.reason ?? 'not recorded'}`];
}

function collectEvidenceLinks(
  surface: WorkReviewSurface,
): ReviewEvidenceLink[] {
  const seen = new Set<string>();
  const links: ReviewEvidenceLink[] = [];
  for (const group of surface.evidenceGroups) {
    for (const link of group.links) {
      const key = `${link.kind}:${link.href}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      links.push(link);
      if (links.length >= 10) {
        return links;
      }
    }
  }
  return links;
}

function extractExactCommand(note?: string | null): string {
  if (!note) {
    return 'not recorded';
  }
  const commandLine = /(?:exactCommand|command):\s*([^\n]+)/iu.exec(note);
  if (commandLine?.[1]) {
    return commandLine[1].trim();
  }
  const approvalLine = /Command requires approval:\s*([^\n]+)/iu.exec(note);
  if (approvalLine?.[1]) {
    return approvalLine[1].trim();
  }
  return 'not recorded';
}

function deriveRiskLabel(
  note: string | null | undefined,
  gate: GateResult | null,
): string {
  const riskLine = /risk:\s*([a-z-]+)/iu.exec(note ?? '');
  if (riskLine?.[1]) {
    return riskLine[1].toLowerCase();
  }
  if (gate?.gateType === 'human') {
    return 'human-control';
  }
  if (gate?.failureClassification) {
    return gate.failureClassification;
  }
  return 'normal';
}

function isCopyableApprovalCommand(command: string, requiredTokens: string[]) {
  const tokens = command.split(/\s+/u).filter(Boolean);
  return (
    requiredTokens.every((token, index) => tokens[index] === token) &&
    !/[<>]/u.test(command)
  );
}

function commandHasFlagValues(command: string, requiredFlags: string[]) {
  const tokens = command.split(/\s+/u).filter(Boolean);
  return requiredFlags.every((flag) => {
    const index = tokens.indexOf(flag);
    if (index < 0) {
      return false;
    }
    const value = tokens[index + 1];
    return Boolean(value) && !value.startsWith('-') && !/[<>]/u.test(value);
  });
}

function commandHasAnyFlag(command: string, flags: string[]) {
  const tokens = command.split(/\s+/u).filter(Boolean);
  return flags.some((flag) =>
    tokens.some((token) => token === flag || token.startsWith(`${flag}=`)),
  );
}

function quoteCliArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
