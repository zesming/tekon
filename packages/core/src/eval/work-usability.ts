import { resolve, sep } from 'node:path';

import { z } from 'zod';

import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import type {
  DeliveryPullRequest,
  RunProviderConfig,
} from '../types/domain.js';
import {
  evaluateWorkReadiness,
  type WorkReadinessEvaluation,
} from './work-readiness.js';

export const workUsabilityThresholdsSchema = z
  .object({
    minSamples: z.number().int().min(0).default(10),
    minReadyRuns: z.number().int().min(0).default(5),
    minRealProviderRuns: z.number().int().min(0).default(5),
    minCreatedPrs: z.number().int().min(0).default(2),
    requireIsolationEvidence: z.boolean().default(true),
  })
  .strict();
export type WorkUsabilityThresholds = z.infer<
  typeof workUsabilityThresholdsSchema
>;

export const workUsabilitySampleSchema = z
  .object({
    id: z.string().min(1),
    runId: z.string().min(1),
    demandType: z
      .enum(['B', 'D', 'feature', 'bugfix', 'test', 'docs', 'other'])
      .optional(),
    expectedProvider: z
      .enum(['mock', 'claude-code', 'codex', 'custom'])
      .optional(),
    requireRealProvider: z.boolean().default(false),
    requirePr: z.boolean().default(false),
    expectedPrUrl: z.string().url().optional(),
    notes: z.string().optional(),
  })
  .strict();
export type WorkUsabilitySample = z.infer<typeof workUsabilitySampleSchema>;

export const workUsabilitySampleSetSchema = z
  .object({
    thresholds: workUsabilityThresholdsSchema.partial().default({}),
    samples: z.array(workUsabilitySampleSchema).default([]),
  })
  .strict();
export type WorkUsabilitySampleSet = z.infer<
  typeof workUsabilitySampleSetSchema
>;

export interface WorkUsabilityCheck {
  id: string;
  passed: boolean;
  evidence: string;
}

export interface WorkUsabilitySampleEvaluation {
  id: string;
  runId: string;
  runPresent: boolean;
  readiness: WorkReadinessEvaluation | null;
  provider: RunProviderConfig['provider'] | null;
  realProvider: boolean;
  prCreated: boolean;
  prUrl: string | null;
  securityScanPassed: boolean;
  isolationPassed: boolean;
  checks: WorkUsabilityCheck[];
}

export interface WorkUsabilityEvaluation {
  usable: boolean;
  score: number;
  thresholds: WorkUsabilityThresholds;
  counts: {
    samples: number;
    readyRuns: number;
    realProviderRuns: number;
    createdPrs: number;
    securityScanPassed: number;
    isolationPassed: number;
  };
  thresholdChecks: WorkUsabilityCheck[];
  samples: WorkUsabilitySampleEvaluation[];
}

export interface UpsertWorkUsabilitySampleResult {
  sampleSet: WorkUsabilitySampleSet;
  created: boolean;
}

export interface RenderWorkUsabilityEvaluationReportInput {
  title: string;
  generatedAt: string;
  samplePath?: string;
  evaluation: WorkUsabilityEvaluation;
}

export interface RenderedWorkUsabilityEvaluationReport {
  markdown: string;
  html: string;
}

export function upsertWorkUsabilitySample(
  sampleSet: WorkUsabilitySampleSet,
  sample: WorkUsabilitySample,
): UpsertWorkUsabilitySampleResult {
  const parsedSampleSet = workUsabilitySampleSetSchema.parse(sampleSet);
  const parsedSample = workUsabilitySampleSchema.parse(sample);
  const existingIndex = parsedSampleSet.samples.findIndex(
    (entry) => entry.id === parsedSample.id,
  );
  const samples =
    existingIndex === -1
      ? [...parsedSampleSet.samples, parsedSample]
      : parsedSampleSet.samples.map((entry, index) =>
          index === existingIndex ? parsedSample : entry,
        );

  return {
    sampleSet: {
      thresholds: parsedSampleSet.thresholds,
      samples,
    },
    created: existingIndex === -1,
  };
}

export async function evaluateWorkUsability(input: {
  repoPath: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  sampleSet: WorkUsabilitySampleSet;
}): Promise<WorkUsabilityEvaluation> {
  const thresholds = workUsabilityThresholdsSchema.parse({
    ...workUsabilityThresholdsSchema.parse({}),
    ...input.sampleSet.thresholds,
  });
  const samples = await Promise.all(
    input.sampleSet.samples.map((sample) =>
      evaluateSample({
        repoPath: input.repoPath,
        repositories: input.repositories,
        audit: input.audit,
        sample,
      }),
    ),
  );

  const counts = {
    samples: samples.length,
    readyRuns: samples.filter((sample) => sample.readiness?.ready).length,
    realProviderRuns: samples.filter((sample) => sample.realProvider).length,
    createdPrs: samples.filter((sample) => sample.prCreated).length,
    securityScanPassed: samples.filter((sample) => sample.securityScanPassed)
      .length,
    isolationPassed: samples.filter((sample) => sample.isolationPassed).length,
  };
  const sampleRequirementFailures = samples.flatMap((sample) =>
    sample.checks.filter(
      (check) => isSampleRequiredCheck(check, thresholds) && !check.passed,
    ),
  );
  const thresholdChecks: WorkUsabilityCheck[] = [
    {
      id: 'sample-count',
      passed: counts.samples >= thresholds.minSamples,
      evidence: `${counts.samples}/${thresholds.minSamples} samples recorded`,
    },
    {
      id: 'ready-run-count',
      passed: counts.readyRuns >= thresholds.minReadyRuns,
      evidence: `${counts.readyRuns}/${thresholds.minReadyRuns} runs ready for human review`,
    },
    {
      id: 'real-provider-run-count',
      passed: counts.realProviderRuns >= thresholds.minRealProviderRuns,
      evidence: `${counts.realProviderRuns}/${thresholds.minRealProviderRuns} real provider runs`,
    },
    {
      id: 'created-pr-count',
      passed: counts.createdPrs >= thresholds.minCreatedPrs,
      evidence: `${counts.createdPrs}/${thresholds.minCreatedPrs} PRs created`,
    },
    {
      id: 'isolation-evidence',
      passed:
        !thresholds.requireIsolationEvidence ||
        (counts.samples > 0 && counts.isolationPassed === counts.samples),
      evidence: `${counts.isolationPassed}/${counts.samples} samples have isolation evidence`,
    },
    {
      id: 'sample-required-checks',
      passed: sampleRequirementFailures.length === 0,
      evidence: `${sampleRequirementFailures.length} sample requirement failures`,
    },
  ];
  const allChecks = [
    ...thresholdChecks,
    ...samples.flatMap((sample) => sample.checks),
  ];
  const passedChecks = allChecks.filter((check) => check.passed).length;

  return {
    usable: thresholdChecks.every((check) => check.passed),
    score: allChecks.length === 0 ? 0 : passedChecks / allChecks.length,
    thresholds,
    counts,
    thresholdChecks,
    samples,
  };
}

export function renderWorkUsabilityEvaluationReport(
  input: RenderWorkUsabilityEvaluationReportInput,
): RenderedWorkUsabilityEvaluationReport {
  const failedSampleChecks = input.evaluation.samples.flatMap((sample) =>
    sample.checks
      .filter((check) => !check.passed)
      .map((check) => `${sample.id}:${check.id} ${check.evidence}`),
  );
  const samplePath = input.samplePath ?? 'not_recorded';
  const markdown = [
    `# ${input.title}`,
    '',
    `generatedAt: ${input.generatedAt}`,
    `samplePath: ${samplePath}`,
    `usable: ${input.evaluation.usable}`,
    `score: ${input.evaluation.score.toFixed(2)}`,
    '',
    '## Counts',
    '',
    `- samples: ${input.evaluation.counts.samples}`,
    `- readyRuns: ${input.evaluation.counts.readyRuns}`,
    `- realProviderRuns: ${input.evaluation.counts.realProviderRuns}`,
    `- createdPrs: ${input.evaluation.counts.createdPrs}`,
    `- securityScanPassed: ${input.evaluation.counts.securityScanPassed}`,
    `- isolationPassed: ${input.evaluation.counts.isolationPassed}`,
    '',
    '## Threshold Checks',
    '',
    ...input.evaluation.thresholdChecks.map(
      (check) => `- ${check.id}: ${check.passed} - ${check.evidence}`,
    ),
    '',
    '## Failed Sample Checks',
    '',
    ...(failedSampleChecks.length === 0
      ? ['- none']
      : failedSampleChecks.map((check) => `- ${check}`)),
    '',
    '## Samples',
    '',
    ...input.evaluation.samples.map((sample) =>
      [
        `- ${sample.id}: runId=${sample.runId} ready=${sample.readiness?.ready ?? false} provider=${sample.provider ?? 'missing'} prCreated=${sample.prCreated} isolation=${sample.isolationPassed}`,
        `  - prUrl: ${sample.prUrl ?? 'missing'}`,
        `  - securityScanPassed: ${sample.securityScanPassed}`,
      ].join('\n'),
    ),
    '',
    '## Judgment',
    '',
    input.evaluation.usable
      ? '- The recorded sample set satisfies the configured work usability thresholds.'
      : '- The recorded sample set does not yet satisfy the configured work usability thresholds.',
    '- This report is evidence for the recorded sample set only; it does not prove production readiness outside the sampled repositories and runs.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8" />',
    '<meta name="viewport" content="width=device-width, initial-scale=1" />',
    `<title>${escapeHtml(input.title)}</title>`,
    '<style>',
    'body{margin:0;background:#f6f7f9;color:#1f2937;font-family:system-ui,sans-serif;}',
    'main{max-width:1040px;margin:0 auto;padding:32px 20px 56px;}',
    'section{margin:24px 0;}',
    'table{width:100%;border-collapse:collapse;background:#fff;}',
    'th,td{border:1px solid #d8dde6;padding:10px;text-align:left;vertical-align:top;}',
    'code{background:#eef1f5;padding:2px 4px;border-radius:4px;}',
    '.summary{background:#fff;border:1px solid #d8dde6;padding:16px;}',
    '.pass{color:#047857;font-weight:700;}',
    '.fail{color:#b91c1c;font-weight:700;}',
    '</style>',
    '</head>',
    '<body><main>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    '<div class="summary">',
    `<p>generatedAt: <code>${escapeHtml(input.generatedAt)}</code></p>`,
    `<p>samplePath: <code>${escapeHtml(samplePath)}</code></p>`,
    `<p>usable: <span class="${input.evaluation.usable ? 'pass' : 'fail'}">${input.evaluation.usable}</span></p>`,
    `<p>score: ${input.evaluation.score.toFixed(2)}</p>`,
    '</div>',
    '<section><h2>Counts</h2><table><tbody>',
    countRow('samples', input.evaluation.counts.samples),
    countRow('readyRuns', input.evaluation.counts.readyRuns),
    countRow('realProviderRuns', input.evaluation.counts.realProviderRuns),
    countRow('createdPrs', input.evaluation.counts.createdPrs),
    countRow('securityScanPassed', input.evaluation.counts.securityScanPassed),
    countRow('isolationPassed', input.evaluation.counts.isolationPassed),
    '</tbody></table></section>',
    '<section><h2>Threshold Checks</h2><table><thead><tr><th>check</th><th>passed</th><th>evidence</th></tr></thead><tbody>',
    ...input.evaluation.thresholdChecks.map(
      (check) =>
        `<tr><td>${escapeHtml(check.id)}</td><td class="${check.passed ? 'pass' : 'fail'}">${check.passed}</td><td>${escapeHtml(check.evidence)}</td></tr>`,
    ),
    '</tbody></table></section>',
    '<section><h2>Samples</h2><table><thead><tr><th>sample</th><th>run</th><th>ready</th><th>provider</th><th>PR</th><th>isolation</th><th>failed checks</th></tr></thead><tbody>',
    ...input.evaluation.samples.map((sample) => {
      const failed = sample.checks
        .filter((check) => !check.passed)
        .map((check) => `${check.id}: ${check.evidence}`)
        .join('; ');
      return `<tr><td>${escapeHtml(sample.id)}</td><td>${escapeHtml(sample.runId)}</td><td>${sample.readiness?.ready ?? false}</td><td>${escapeHtml(sample.provider ?? 'missing')}</td><td>${escapeHtml(sample.prUrl ?? 'missing')}</td><td>${sample.isolationPassed}</td><td>${escapeHtml(failed || 'none')}</td></tr>`;
    }),
    '</tbody></table></section>',
    '<section><h2>Judgment</h2>',
    `<p>${escapeHtml(
      input.evaluation.usable
        ? 'The recorded sample set satisfies the configured work usability thresholds.'
        : 'The recorded sample set does not yet satisfy the configured work usability thresholds.',
    )}</p>`,
    '<p>This report is evidence for the recorded sample set only; it does not prove production readiness outside the sampled repositories and runs.</p>',
    '</section>',
    '</main></body></html>',
  ].join('');

  return { markdown, html };
}

function isSampleRequiredCheck(
  check: WorkUsabilityCheck,
  thresholds: WorkUsabilityThresholds,
): boolean {
  if (['worktree-lease-present', 'worktree-path-managed'].includes(check.id)) {
    return thresholds.requireIsolationEvidence;
  }
  return true;
}

async function evaluateSample(input: {
  repoPath: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  sample: WorkUsabilitySample;
}): Promise<WorkUsabilitySampleEvaluation> {
  const workflow = await input.repositories.getWorkflowInstance(
    input.sample.runId,
  );
  if (!workflow) {
    return {
      id: input.sample.id,
      runId: input.sample.runId,
      runPresent: false,
      readiness: null,
      provider: null,
      realProvider: false,
      prCreated: false,
      prUrl: null,
      securityScanPassed: false,
      isolationPassed: false,
      checks: [
        {
          id: 'run-present',
          passed: false,
          evidence: `run not found: ${input.sample.runId}`,
        },
      ],
    };
  }

  const [readiness, provider, deliveryPr, leases] = await Promise.all([
    evaluateWorkReadiness({
      repositories: input.repositories,
      audit: input.audit,
      runId: input.sample.runId,
      repoPath: input.repoPath,
    }),
    input.repositories.getRunProviderConfig(input.sample.runId),
    input.repositories.getDeliveryPullRequest(input.sample.runId),
    input.repositories.listWorktreeLeases(input.sample.runId),
  ]);
  const providerName = provider?.provider ?? null;
  const realProvider = Boolean(providerName && providerName !== 'mock');
  const prCreated = Boolean(
    deliveryPr?.status === 'created' && deliveryPr.prUrl,
  );
  const securityScanPassed =
    readiness.checks.find((check) => check.id === 'security-scans-passed')
      ?.passed ?? false;
  const isolation = evaluateIsolationEvidence({
    repoPath: input.repoPath,
    leases,
    deliveryPr,
  });
  const checks: WorkUsabilityCheck[] = [
    {
      id: 'run-present',
      passed: true,
      evidence: `workflow status is ${workflow.status}`,
    },
    {
      id: 'expected-provider',
      passed:
        !input.sample.expectedProvider ||
        providerName === input.sample.expectedProvider,
      evidence: `provider is ${providerName ?? 'missing'}`,
    },
    {
      id: 'real-provider-required',
      passed: !input.sample.requireRealProvider || realProvider,
      evidence: realProvider
        ? `real provider is ${providerName}`
        : `provider is ${providerName ?? 'missing'}`,
    },
    {
      id: 'pr-required',
      passed: !input.sample.requirePr || prCreated,
      evidence: prCreated
        ? `PR created: ${deliveryPr?.prUrl ?? ''}`
        : `PR status is ${deliveryPr?.status ?? 'not-created'}`,
    },
    {
      id: 'expected-pr-url',
      passed:
        !input.sample.expectedPrUrl ||
        deliveryPr?.prUrl === input.sample.expectedPrUrl,
      evidence: `PR URL is ${deliveryPr?.prUrl ?? 'missing'}`,
    },
    ...isolation.checks,
  ];

  return {
    id: input.sample.id,
    runId: input.sample.runId,
    runPresent: true,
    readiness,
    provider: providerName,
    realProvider,
    prCreated,
    prUrl: deliveryPr?.prUrl ?? null,
    securityScanPassed,
    isolationPassed: isolation.passed,
    checks,
  };
}

function evaluateIsolationEvidence(input: {
  repoPath: string;
  leases: Array<{
    repoPath: string;
    worktreePath: string;
    releasedAt?: string | null;
  }>;
  deliveryPr: DeliveryPullRequest | null;
}): { passed: boolean; checks: WorkUsabilityCheck[] } {
  const managedLeases = input.leases.filter((lease) =>
    isManagedWorktreePath(input.repoPath, lease.worktreePath),
  );
  const openLeases = input.leases.filter((lease) => !lease.releasedAt);
  const remoteSideEffect = Boolean(
    input.deliveryPr?.branchPushedAt ||
    input.deliveryPr?.prCreatedAt ||
    input.deliveryPr?.prUrl,
  );
  const remoteApproved = Boolean(
    !remoteSideEffect ||
    (input.deliveryPr?.approvedBy && input.deliveryPr.approvedAt),
  );
  const checks: WorkUsabilityCheck[] = [
    {
      id: 'worktree-lease-present',
      passed: input.leases.length > 0,
      evidence: `${input.leases.length} worktree leases recorded`,
    },
    {
      id: 'worktree-path-managed',
      passed:
        input.leases.length > 0 && managedLeases.length === input.leases.length,
      evidence: `${managedLeases.length}/${input.leases.length} worktree paths are under .tekon/worktrees`,
    },
    {
      id: 'worktree-leases-released',
      passed: openLeases.length === 0,
      evidence: `${openLeases.length} open worktree leases`,
    },
    {
      id: 'remote-side-effects-approved',
      passed: remoteApproved,
      evidence: remoteSideEffect
        ? `delivery status ${input.deliveryPr?.status ?? 'missing'} approvedBy=${input.deliveryPr?.approvedBy ?? ''}`
        : 'no remote side effects recorded',
    },
  ];
  return {
    passed: checks.every((check) => check.passed),
    checks,
  };
}

function isManagedWorktreePath(
  repoPath: string,
  worktreePath: string,
): boolean {
  const root = resolve(repoPath, '.tekon', 'worktrees');
  const target = resolve(worktreePath);
  return target === root || target.startsWith(`${root}${sep}`);
}

function countRow(name: string, value: number) {
  return `<tr><th>${escapeHtml(name)}</th><td>${value}</td></tr>`;
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
