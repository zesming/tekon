import { parseArgs } from 'node:util';

import {
  createAuditLogger,
  createHumanApprovalSummary,
  createWorkReviewSurface,
  evaluateHumanApprovalSummary,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';
import {
  ensureInitialized,
  withProjectContext,
} from '../lib/context.js';
import {
  selectLatestRunId,
} from '../lib/db-helpers.js';
import { resolveProjectRepoPath } from '../lib/path-utils.js';

export async function commandReview(
  argv: string[],
  io: CliIO,
) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
      json: { type: 'boolean', default: false },
      'max-chars': { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  const maxContentChars = args.values['max-chars']
    ? Number(args.values['max-chars'])
    : 1_200;
  if (
    !Number.isFinite(maxContentChars) ||
    maxContentChars <= 0
  ) {
    throw new Error('--max-chars 必须是正数');
  }
  await withProjectContext(
    repoPath,
    async ({ db, repos: repositories }) => {
      const runId =
        args.values['run-id'] ??
        args.positionals[0] ??
        selectLatestRunId(db);
      if (!runId) {
        throw new Error(
          '无法推断运行 ID，请使用 --run-id <runId> 指定',
        );
      }
      const audit = createAuditLogger({ repositories });
      const surface = await createWorkReviewSurface({
        repoPath,
        repositories,
        audit,
        runId,
        maxContentChars,
        commandDisplay:
          (args.values.repo ??
          args.values['run-id'] ??
          args.positionals[0])
            ? 'explicit'
            : 'default',
      });

      if (args.values.json) {
        io.stdout.write(
          `${JSON.stringify(surface, null, 2)}\n`,
        );
        return;
      }

      io.stdout.write(formatReviewSurface(surface));
    },
  );
}

export function formatReviewSurface(
  surface: Awaited<ReturnType<typeof createWorkReviewSurface>>,
): string {
  const failedChecks = surface.readiness.checks.filter(
    (check) => !check.passed,
  );
  const lines = [
    `runId=${surface.runId}`,
    `workflowStatus=${surface.workflowStatus}`,
    `ready=${surface.readiness.ready}`,
    `score=${surface.readiness.score.toFixed(2)}`,
    `deliveryStatus=${surface.delivery.status}`,
    `prUrl=${surface.delivery.prUrl ?? ''}`,
    '',
    '## Readiness Failed Checks',
    ...(failedChecks.length === 0
      ? ['- none']
      : failedChecks.map(
          (check) =>
            `- ${check.id} (${check.severity}): ${check.evidence}`,
        )),
    '',
    '## Evidence Navigation',
    ...(surface.evidenceGroups.length === 0
      ? ['- none']
      : surface.evidenceGroups.map((group) =>
          [
            `### ${group.title} ${group.status}`,
            `summary=${group.summary}`,
            ...group.links.map(
              (link) =>
                `- ${link.kind} ${link.label} -> ${link.href} (${link.summary})`,
            ),
          ].join('\n'),
        )),
    '',
    '## Gate Failure Triage',
    ...(surface.gateFailureTriage.length === 0
      ? ['- none']
      : surface.gateFailureTriage.map((item) =>
          [
            `### ${item.gateType} ${item.gateId} ${item.status}`,
            `classification=${item.classification} retry=${item.retry} log=${item.logHref}`,
            `summary=${item.summary}`,
            `suggestedCommand=${item.suggestedCommand}`,
          ].join('\n'),
        )),
    '',
    '## Delivery',
    `- packagePath: ${surface.delivery.package?.path ?? 'missing'}`,
    `- prBodyPath: ${surface.delivery.prBody?.path ?? 'missing'}`,
    `- diffAvailable: ${surface.delivery.diff.available}`,
    `- diffBranch: ${surface.delivery.diff.branch}`,
    `- diffBase: ${surface.delivery.diff.baseBranch}`,
    ...(surface.delivery.diff.reason
      ? [
          `- diffReason: ${surface.delivery.diff.reason}`,
        ]
      : []),
    '',
    '## Changed Files',
    ...(surface.delivery.diff.changedFiles.length === 0
      ? ['- none']
      : surface.delivery.diff.changedFiles.map(
          (file) => `- ${file}`,
        )),
    '',
    '## Artifacts',
    ...(surface.artifacts.length === 0
      ? ['- none']
      : surface.artifacts.map((artifact) =>
          [
            `### ${artifact.type} ${artifact.id}`,
            `path=${artifact.path} summary=${artifact.summary ?? ''}`,
            formatPreview(artifact.content),
          ].join('\n'),
        )),
    '',
    '## Gate Logs',
    ...(surface.gates.length === 0
      ? ['- none']
      : surface.gates.map((gate) =>
          [
            `### ${gate.gateType} ${gate.id} ${gate.status}`,
            `node=${gate.nodeId} failure=${gate.failureClassification ?? ''}`,
            gate.output
              ? formatPreview(gate.output)
              : 'output=missing',
          ].join('\n'),
        )),
    '',
    '## PR Body',
    surface.delivery.prBody
      ? formatPreview(surface.delivery.prBody)
      : 'missing',
    '',
    '## PR Package',
    surface.delivery.package
      ? formatPreview(surface.delivery.package)
      : 'missing',
    '',
    '## Next Commands',
    ...surface.nextCommands.map((command) => `- ${command}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

export function formatApprovalSummary(
  summary: Awaited<
    ReturnType<typeof createHumanApprovalSummary>
  >,
  evaluation: ReturnType<
    typeof evaluateHumanApprovalSummary
  >,
): string {
  return [
    `decisionId=${summary.decisionId}`,
    `runId=${summary.runId}`,
    `ready=${evaluation.ready}`,
    `score=${evaluation.score.toFixed(2)}`,
    `risk=${summary.riskLabel}`,
    `exactCommand=${summary.exactCommand}`,
    `impact=${summary.impact.status}`,
    `failed=${evaluation.checks
      .filter((check) => !check.passed)
      .map((check) => check.id)
      .join(',')}`,
    '',
    summary.summaryText,
  ].join('\n');
}

export function formatPreview(preview: {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}): string {
  if (!preview.exists) {
    return `path=${preview.path} exists=false`;
  }
  return [
    `path=${preview.path} sizeBytes=${preview.sizeBytes} truncated=${preview.truncated}`,
    '```',
    preview.content,
    '```',
  ].join('\n');
}
