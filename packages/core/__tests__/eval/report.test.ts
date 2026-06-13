import { describe, expect, it } from 'vitest';

import { renderRunEvaluationReport } from '../../src/eval/report.js';
import type { RunMetrics } from '../../src/eval/metrics.js';

describe('eval report', () => {
  it('renders markdown and html without claiming unverified web or real PR capability', () => {
    const metrics: RunMetrics = {
      runId: 'run_1',
      workflowStatus: 'passed',
      demandTitle: 'Refund feature',
      timeToLocalPackageMs: 10_000,
      timeToPrMs: null,
      gatePassRate: 1,
      gateByType: {
        build: { passed: 1, failed: 0, blocked: 0, skipped: 0 },
      },
      retryCount: 0,
      humanInterventions: {
        total: 1,
        pending: 0,
        approved: 1,
        rejected: 0,
        averageWaitMs: 2000,
      },
      artifactIntegrity: {
        total: 1,
        existing: 1,
        sha256Matched: 1,
        missing: [],
        mismatched: [],
      },
      audit: {
        valid: true,
        eventCount: 3,
        headHash: 'hash_3',
      },
      automationRatio: 0.5,
      highRiskActionCount: 1,
      worktreeLeases: {
        total: 1,
        open: 0,
      },
      prUrl: null,
    };

    const report = renderRunEvaluationReport({
      title: 'Dogfooding',
      evidenceLevel: 'scm-dry-run',
      metrics,
      webStatus: 'not_implemented',
      scmStatus: 'dry_run',
      coverageStatus: 'not_measured',
    });

    expect(report.markdown).toContain('# Dogfooding');
    expect(report.markdown).toContain('evidenceLevel: scm-dry-run');
    expect(report.markdown).toContain('webStatus: not_implemented');
    expect(report.markdown).toContain('coverageStatus: not_measured');
    expect(report.markdown).toContain('PR URL: not_created');
    expect(report.html).toContain('<h1>Dogfooding</h1>');
    expect(report.html).toContain('not_implemented');
    expect(report.html).not.toContain('Web dashboard passed');
    expect(report.html).not.toContain('real PR created');
  });

  it('escapes HTML special characters in title and string fields', () => {
    const metrics: RunMetrics = {
      runId: 'run_xss',
      workflowStatus: 'passed',
      timeToLocalPackageMs: 5000,
      timeToPrMs: null,
      gatePassRate: 1,
      gateByType: {},
      retryCount: 0,
      humanInterventions: {
        total: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
        averageWaitMs: null,
      },
      artifactIntegrity: {
        total: 0,
        existing: 0,
        sha256Matched: 0,
        missing: [],
        mismatched: [],
      },
      audit: {
        valid: true,
        eventCount: 1,
      },
      automationRatio: 0,
      highRiskActionCount: 0,
      worktreeLeases: {
        total: 0,
        open: 0,
      },
      prUrl: null,
    };

    const report = renderRunEvaluationReport({
      title: 'Run <script>alert("xss")</script> & "special" chars',
      evidenceLevel: 'local-mock',
      metrics,
      webStatus: 'not_implemented',
      scmStatus: 'dry_run',
      coverageStatus: 'not_measured',
    });

    // Markdown should contain raw characters (not escaped)
    expect(report.markdown).toContain(
      '# Run <script>alert("xss")</script> & "special" chars',
    );
    // HTML should escape <, >, &, "
    expect(report.html).toContain('&lt;script&gt;');
    expect(report.html).toContain('&amp;');
    expect(report.html).toContain('&quot;xss&quot;');
    expect(report.html).toContain('&quot;special&quot;');
    // HTML must not contain raw angle brackets
    expect(report.html).not.toContain('<script>');
  });

  it('renders actual PR URL when prUrl is not null', () => {
    const metrics: RunMetrics = {
      runId: 'run_pr',
      workflowStatus: 'passed',
      timeToLocalPackageMs: 30000,
      timeToPrMs: 45000,
      gatePassRate: 0.8,
      gateByType: {
        build: { passed: 1, failed: 0, blocked: 0, skipped: 0 },
        lint: { passed: 1, failed: 1, blocked: 0, skipped: 0 },
      },
      retryCount: 1,
      humanInterventions: {
        total: 2,
        pending: 0,
        approved: 2,
        rejected: 0,
        averageWaitMs: 15000,
      },
      artifactIntegrity: {
        total: 2,
        existing: 2,
        sha256Matched: 2,
        missing: [],
        mismatched: [],
      },
      audit: {
        valid: true,
        eventCount: 8,
        headHash: 'hash_pr',
      },
      automationRatio: 0.75,
      highRiskActionCount: 2,
      worktreeLeases: {
        total: 1,
        open: 0,
      },
      prUrl: 'https://github.com/tekon/repo/pull/42',
    };

    const report = renderRunEvaluationReport({
      title: 'PR Created Run',
      evidenceLevel: 'real-pr',
      metrics,
      webStatus: 'passed',
      scmStatus: 'real_pr',
      coverageStatus: 'passed',
    });

    // PR URL should appear in both outputs
    expect(report.markdown).toContain(
      'PR URL: https://github.com/tekon/repo/pull/42',
    );
    expect(report.html).toContain(
      'PR URL: https://github.com/tekon/repo/pull/42',
    );
    // Must not contain the null placeholder
    expect(report.markdown).not.toContain('PR URL: not_created');
    expect(report.html).not.toContain('PR URL: not_created');
    // Status enums should render
    expect(report.markdown).toContain('evidenceLevel: real-pr');
    expect(report.markdown).toContain('scmStatus: real_pr');
    expect(report.markdown).toContain('coverageStatus: passed');
    // timeToPrMs should be a number, not null
    expect(report.markdown).toContain('timeToPrMs: 45000');
  });

  it('renders zero metrics and empty gateByType without crashing', () => {
    const metrics: RunMetrics = {
      runId: 'run_zero',
      workflowStatus: 'failed',
      timeToLocalPackageMs: null,
      timeToPrMs: null,
      gatePassRate: 0,
      gateByType: {},
      retryCount: 0,
      humanInterventions: {
        total: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
        averageWaitMs: null,
      },
      artifactIntegrity: {
        total: 0,
        existing: 0,
        sha256Matched: 0,
        missing: [],
        mismatched: [],
      },
      audit: {
        valid: false,
        eventCount: 2,
        brokenEventId: 'evt_broken_zero',
      },
      automationRatio: 0,
      highRiskActionCount: 0,
      worktreeLeases: {
        total: 0,
        open: 0,
      },
      prUrl: null,
    };

    const report = renderRunEvaluationReport({
      title: 'Zero Metrics Run',
      evidenceLevel: 'local-mock',
      metrics,
      webStatus: 'not_implemented',
      scmStatus: 'not_implemented',
      coverageStatus: 'not_measured',
    });

    // Zero values should render as numbers
    expect(report.markdown).toContain('gatePassRate: 0');
    expect(report.markdown).toContain('retryCount: 0');
    expect(report.markdown).toContain('automationRatio: 0');
    expect(report.markdown).toContain('highRiskActionCount: 0');
    // Null metrics should render as 'null'
    expect(report.markdown).toContain('timeToLocalPackageMs: null');
    expect(report.markdown).toContain('timeToPrMs: null');
    // Empty gateByType should not crash
    expect(report.markdown).toContain('## Metrics');
    // Failed workflow status
    expect(report.markdown).toContain('workflowStatus: failed');
    // Invalid audit still renders
    expect(report.markdown).toContain('auditValid: false');
    // Zero artifactIntegrity renders
    expect(report.markdown).toContain('artifactIntegrity: 0/0');
    // Limitations section still present
    expect(report.markdown).toContain('## Limitations');
    // Empty humanInterventions
    expect(report.markdown).toContain('workflowStatus: failed');
  });

  it('renders failed workflow with artifact mismatches and broken audit chain', () => {
    const metrics: RunMetrics = {
      runId: 'run_fail',
      workflowStatus: 'failed',
      demandTitle: 'Broken feature attempt',
      timeToLocalPackageMs: 120000,
      timeToPrMs: null,
      gatePassRate: 0.25,
      gateByType: {
        build: { passed: 1, failed: 0, blocked: 0, skipped: 0 },
        test: { passed: 0, failed: 3, blocked: 0, skipped: 0 },
        security: { passed: 0, failed: 0, blocked: 1, skipped: 0 },
      },
      retryCount: 3,
      humanInterventions: {
        total: 1,
        pending: 0,
        approved: 0,
        rejected: 1,
        averageWaitMs: 5000,
      },
      artifactIntegrity: {
        total: 3,
        existing: 2,
        sha256Matched: 1,
        missing: ['dist/legacy.js'],
        mismatched: ['dist/bundle.js'],
      },
      audit: {
        valid: false,
        eventCount: 5,
        brokenEventId: 'evt_hash_mismatch',
      },
      automationRatio: 0.6,
      highRiskActionCount: 2,
      worktreeLeases: {
        total: 2,
        open: 1,
      },
      prUrl: null,
    };

    const report = renderRunEvaluationReport({
      title: 'Failed Workflow Report',
      evidenceLevel: 'scm-dry-run',
      metrics,
      webStatus: 'not_implemented',
      scmStatus: 'dry_run',
      coverageStatus: 'failed',
    });

    // Failed workflow status
    expect(report.markdown).toContain('workflowStatus: failed');
    // Gate pass rate 0.25
    expect(report.markdown).toContain('gatePassRate: 0.25');
    // Rejected human intervention
    expect(report.markdown).toContain('PR URL: not_created');
    // Artifact integrity with mismatches and missing
    expect(report.markdown).toContain('artifactIntegrity: 1/3');
    // Failed audit
    expect(report.markdown).toContain('auditValid: false');
    // Failed coverage
    expect(report.markdown).toContain('coverageStatus: failed');
    // Open worktree lease
    expect(report.markdown).toContain('retryCount: 3');
    // HTML counterpart
    expect(report.html).toContain('<h1>Failed Workflow Report</h1>');
    expect(report.html).toContain('failed');
    // Limitations still present
    expect(report.html).toContain('Limitations');
  });

  it('renders minimal input with only required metrics fields', () => {
    const metrics: RunMetrics = {
      runId: 'run_minimal',
      workflowStatus: 'passed',
      timeToLocalPackageMs: null,
      timeToPrMs: null,
      gatePassRate: 0,
      gateByType: {},
      retryCount: 0,
      humanInterventions: {
        total: 0,
        pending: 0,
        approved: 0,
        rejected: 0,
        averageWaitMs: null,
      },
      artifactIntegrity: {
        total: 0,
        existing: 0,
        sha256Matched: 0,
        missing: [],
        mismatched: [],
      },
      audit: {
        valid: true,
        eventCount: 0,
      },
      automationRatio: 0,
      highRiskActionCount: 0,
      worktreeLeases: {
        total: 0,
        open: 0,
      },
      prUrl: null,
    };

    const report = renderRunEvaluationReport({
      title: 'Minimal',
      evidenceLevel: 'local-mock',
      metrics,
      webStatus: 'not_implemented',
      scmStatus: 'not_implemented',
      coverageStatus: 'not_measured',
    });

    // Should produce non-empty output
    expect(report.markdown).toBeTruthy();
    expect(report.html).toBeTruthy();
    // Should contain the title
    expect(report.markdown).toContain('# Minimal');
    expect(report.html).toContain('<h1>Minimal</h1>');
    // Key sections must exist
    expect(report.markdown).toContain('## Metrics');
    expect(report.markdown).toContain('## Limitations');
    // All required header fields present
    expect(report.markdown).toContain('evidenceLevel: local-mock');
    expect(report.markdown).toContain('runId: run_minimal');
    expect(report.markdown).toContain('webStatus: not_implemented');
    expect(report.markdown).toContain('scmStatus: not_implemented');
    expect(report.markdown).toContain('coverageStatus: not_measured');
    expect(report.markdown).toContain('PR URL: not_created');
    // HTML must have closing tags (well-formed)
    expect(report.html).toContain('</main>');
    expect(report.html).toContain('</body>');
    expect(report.html).toContain('</html>');
  });
});
