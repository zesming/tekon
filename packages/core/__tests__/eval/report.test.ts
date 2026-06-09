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
});
