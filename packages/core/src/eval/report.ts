import type { RunMetrics } from './metrics.js';

export interface RenderRunEvaluationReportInput {
  title: string;
  evidenceLevel: 'local-mock' | 'scm-dry-run' | 'real-pr-fixture' | 'real-pr';
  metrics: RunMetrics;
  webStatus: 'not_implemented' | 'not_verified' | 'passed';
  scmStatus: 'not_implemented' | 'dry_run' | 'fake_fixture' | 'real_pr';
  coverageStatus: 'not_measured' | 'passed' | 'failed';
}

export interface RenderedRunEvaluationReport {
  markdown: string;
  html: string;
}

export function renderRunEvaluationReport(
  input: RenderRunEvaluationReportInput,
): RenderedRunEvaluationReport {
  const prUrl = input.metrics.prUrl ?? 'not_created';
  const markdown = [
    `# ${input.title}`,
    '',
    `evidenceLevel: ${input.evidenceLevel}`,
    `runId: ${input.metrics.runId}`,
    `workflowStatus: ${input.metrics.workflowStatus}`,
    `webStatus: ${input.webStatus}`,
    `scmStatus: ${input.scmStatus}`,
    `coverageStatus: ${input.coverageStatus}`,
    `PR URL: ${prUrl}`,
    '',
    '## Metrics',
    '',
    `- timeToLocalPackageMs: ${formatNullable(input.metrics.timeToLocalPackageMs)}`,
    `- timeToPrMs: ${formatNullable(input.metrics.timeToPrMs)}`,
    `- gatePassRate: ${input.metrics.gatePassRate}`,
    `- retryCount: ${input.metrics.retryCount}`,
    `- automationRatio: ${input.metrics.automationRatio}`,
    `- highRiskActionCount: ${input.metrics.highRiskActionCount}`,
    `- auditValid: ${input.metrics.audit.valid}`,
    `- artifactIntegrity: ${input.metrics.artifactIntegrity.sha256Matched}/${input.metrics.artifactIntegrity.total}`,
    '',
    '## Limitations',
    '',
    '- Dry-run only proves command planning and approval boundaries; it does not prove a remote PR was created.',
    '- Web status is reported separately and must not be inferred from CLI success.',
    '- Coverage status is explicit; not_measured is not a pass.',
  ].join('\n');

  const html = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head><meta charset="utf-8" /><title>',
    escapeHtml(input.title),
    '</title></head>',
    '<body><main>',
    `<h1>${escapeHtml(input.title)}</h1>`,
    `<p>evidenceLevel: ${escapeHtml(input.evidenceLevel)}</p>`,
    `<p>runId: ${escapeHtml(input.metrics.runId)}</p>`,
    `<p>workflowStatus: ${escapeHtml(input.metrics.workflowStatus)}</p>`,
    `<p>webStatus: ${escapeHtml(input.webStatus)}</p>`,
    `<p>scmStatus: ${escapeHtml(input.scmStatus)}</p>`,
    `<p>coverageStatus: ${escapeHtml(input.coverageStatus)}</p>`,
    `<p>PR URL: ${escapeHtml(prUrl)}</p>`,
    '<h2>Metrics</h2>',
    '<ul>',
    `<li>timeToLocalPackageMs: ${formatNullable(input.metrics.timeToLocalPackageMs)}</li>`,
    `<li>timeToPrMs: ${formatNullable(input.metrics.timeToPrMs)}</li>`,
    `<li>gatePassRate: ${input.metrics.gatePassRate}</li>`,
    `<li>retryCount: ${input.metrics.retryCount}</li>`,
    `<li>automationRatio: ${input.metrics.automationRatio}</li>`,
    `<li>highRiskActionCount: ${input.metrics.highRiskActionCount}</li>`,
    `<li>auditValid: ${input.metrics.audit.valid}</li>`,
    '</ul>',
    '<h2>Limitations</h2>',
    '<p>Dry-run only proves command planning and approval boundaries; it does not prove a remote PR was created.</p>',
    '<p>Web status is reported separately and must not be inferred from CLI success.</p>',
    '</main></body></html>',
  ].join('');

  return { markdown, html };
}

function formatNullable(value: number | null) {
  return value === null ? 'null' : String(value);
}

function escapeHtml(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
