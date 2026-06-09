import { describe, expect, it } from 'vitest';

import {
  buildHumanApprovalSummary,
  evaluateHumanApprovalSummary,
  type WorkReviewSurface,
} from '../../src/index.js';

describe('human approval summary', () => {
  it('builds a copyable approval summary with risk, impact and decision entries', () => {
    const summary = buildHumanApprovalSummary({
      repoPath: '/repo/donkey',
      decision: {
        id: 'decision_1',
        runId: 'run_1',
        nodeId: 'node_1',
        gateResultId: 'gate_1',
        status: 'pending',
        note: [
          'request: Review before continuing.',
          'exactCommand: donkey delivery create-pr --run-id run_1',
          'risk: high',
        ].join('\n'),
        createdAt: '2026-06-08T00:00:00.000Z',
      },
      node: {
        id: 'node_1',
        runId: 'run_1',
        role: 'reviewer',
        status: 'paused',
        inputs: [],
        outputs: [],
        gates: [],
        dependencies: [],
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z',
      },
      gate: {
        id: 'gate_1',
        runId: 'run_1',
        nodeId: 'node_1',
        gateType: 'human',
        status: 'blocked',
        durationMs: 0,
        retries: 0,
        failureClassification: 'human-approval',
        createdAt: '2026-06-08T00:00:00.000Z',
      },
      surface: createSurfaceFixture(),
    });

    expect(summary).toMatchObject({
      decisionId: 'decision_1',
      riskLabel: 'high',
      exactCommand: 'donkey delivery create-pr --run-id run_1',
      impact: { status: 'available', files: ['packages/web/src/App.tsx'] },
    });
    expect(summary.summaryText).toContain('## 处理入口');
    expect(summary.summaryText).toContain(
      'donkey resume --run-id run_1 --approve-human --repo /repo/donkey',
    );
    expect(summary.rejectCommand).toBe(
      'donkey approval reject --run-id run_1 --decision-id decision_1 --repo /repo/donkey',
    );
    expect(summary.summaryText).toContain(summary.rejectCommand);
    expect(summary.rejectCommand).not.toMatch(/[<>]/u);

    const evaluation = evaluateHumanApprovalSummary(summary);
    expect(evaluation.ready).toBe(true);
    expect(evaluation.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'approval-entry-present', passed: true }),
        expect.objectContaining({
          id: 'rejection-entry-present',
          passed: true,
        }),
        expect.objectContaining({ id: 'impact-context-present', passed: true }),
      ]),
    );
  });

  it('fails evaluation when command context is not recorded', () => {
    const summary = buildHumanApprovalSummary({
      repoPath: '/repo/donkey',
      decision: {
        id: 'decision_1',
        runId: 'run_1',
        nodeId: 'node_1',
        status: 'pending',
        note: 'risk: high',
        createdAt: '2026-06-08T00:00:00.000Z',
      },
      node: null,
      gate: null,
      surface: createSurfaceFixture(),
    });

    const evaluation = evaluateHumanApprovalSummary(summary);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.checks).toContainEqual(
      expect.objectContaining({
        id: 'command-context-present',
        passed: false,
      }),
    );
  });

  it('fails evaluation when rejection entries are not directly copyable', () => {
    const summary = buildReadySummary();

    for (const rejectCommand of [
      'donkey approval reject --run-id run_1 --decision-id decision_1 --actor <name> --repo /repo/donkey',
      'donkey approval reject --run-id run_1 --decision-id decision_1 --actor alice --repo /repo/donkey',
      'donkey approval reject --run-id run_1 --decision-id decision_1 --actor=<name> --repo /repo/donkey',
      'donkey approval reject --run-id run_1 --decision-id decision_1 --actor=alice --repo /repo/donkey',
      'donkey approval reject --run-id run_1 --repo /repo/donkey',
      'donkey approval reject --run-id run_1 --decision-id --repo /repo/donkey',
      'donkey approval reject --run-id --decision-id decision_1 --repo /repo/donkey',
      'donkey approval reject --run-id run_1 --decision-id decision_1 --repo',
    ]) {
      const summaryText = summary.summaryText.replace(
        summary.rejectCommand,
        rejectCommand,
      );
      expect(
        evaluateHumanApprovalSummary({
          ...summary,
          rejectCommand,
          summaryText,
        }).checks,
      ).toContainEqual(
        expect.objectContaining({
          id: 'rejection-entry-present',
          passed: false,
        }),
      );
    }

    expect(
      evaluateHumanApprovalSummary({
        ...summary,
        summaryText: summary.summaryText.replace(summary.rejectCommand, ''),
      }).checks,
    ).toContainEqual(
      expect.objectContaining({
        id: 'copyable-summary-present',
        passed: false,
      }),
    );
  });
});

function buildReadySummary() {
  return buildHumanApprovalSummary({
    repoPath: '/repo/donkey',
    decision: {
      id: 'decision_1',
      runId: 'run_1',
      nodeId: 'node_1',
      gateResultId: 'gate_1',
      status: 'pending',
      note: [
        'request: Review before continuing.',
        'exactCommand: donkey delivery create-pr --run-id run_1',
        'risk: high',
      ].join('\n'),
      createdAt: '2026-06-08T00:00:00.000Z',
    },
    node: {
      id: 'node_1',
      runId: 'run_1',
      role: 'reviewer',
      status: 'paused',
      inputs: [],
      outputs: [],
      gates: [],
      dependencies: [],
      createdAt: '2026-06-08T00:00:00.000Z',
      updatedAt: '2026-06-08T00:00:00.000Z',
    },
    gate: {
      id: 'gate_1',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'human',
      status: 'blocked',
      durationMs: 0,
      retries: 0,
      failureClassification: 'human-approval',
      createdAt: '2026-06-08T00:00:00.000Z',
    },
    surface: createSurfaceFixture(),
  });
}

function createSurfaceFixture(): WorkReviewSurface {
  return {
    runId: 'run_1',
    workflowStatus: 'paused',
    demand: {
      id: 'demand_1',
      title: 'Add approval summary',
      body: 'Review human gate with copyable summary.',
    },
    readiness: {
      runId: 'run_1',
      ready: false,
      score: 0.5,
      checks: [
        {
          id: 'no-pending-human-gates',
          severity: 'required',
          passed: false,
          evidence: '1 pending human decisions',
        },
      ],
    },
    artifacts: [],
    gates: [],
    gateFailureTriage: [],
    delivery: {
      status: 'prepared',
      prUrl: null,
      package: null,
      prBody: null,
      diff: {
        branch: 'donkey-delivery/run_1',
        baseBranch: 'main',
        available: true,
        stat: ' packages/web/src/App.tsx | 10 ++++++++++',
        changedFiles: ['packages/web/src/App.tsx'],
      },
    },
    evidenceGroups: [
      {
        id: 'review-route',
        title: 'Review Route',
        status: 'info',
        severity: 'context',
        summary: 'Inspect diff and gate.',
        links: [
          {
            kind: 'diff',
            label: 'Delivery diff',
            href: '#delivery-diff',
            summary: 'main...donkey-delivery/run_1',
          },
        ],
      },
    ],
    nextCommands: [],
  };
}
