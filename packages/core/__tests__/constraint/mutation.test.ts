import { describe, expect, it } from 'vitest';

import {
  applyConstraintMutations,
  type WorkflowTemplate,
} from '../../src/constraint/validator.js';

describe('constraint workflow mutation', () => {
  it('injects a human gate for high-risk demands with stable constraint metadata', () => {
    const result = applyConstraintMutations(baseWorkflow(), {
      riskLevel: 'high',
      tags: [],
    });

    const implementationNode = result.workflow.phases[0]?.nodes[0];

    expect(implementationNode?.gates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'constraint-gate-human-high-risk',
          type: 'human',
          source: 'constraint',
          explanation: expect.stringContaining('high-risk'),
        }),
      ]),
    );
    expect(result.mutations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'conditional-high-risk-human-gate',
          source: 'constraint',
          explanation: expect.stringContaining('human'),
        }),
      ]),
    );
  });

  it('injects security review and security-scan for auth, security, or permission risk', () => {
    const result = applyConstraintMutations(baseWorkflow(), {
      tags: ['auth', 'permission'],
    });

    const phase = result.workflow.phases.find(
      (candidate) => candidate.id === 'constraint-phase-security-review',
    );
    const node = phase?.nodes[0];

    expect(phase).toMatchObject({
      source: 'constraint',
      explanation: expect.stringContaining('security'),
    });
    expect(node).toMatchObject({
      id: 'constraint-node-security-review',
      role: 'reviewer',
      source: 'constraint',
      explanation: expect.stringContaining('security'),
      outputs: ['security-report'],
    });
    expect(node?.gates).toEqual([
      expect.objectContaining({
        id: 'constraint-gate-security-scan',
        type: 'security-scan',
        source: 'constraint',
        explanation: expect.stringContaining('security-scan'),
      }),
    ]);
  });

  it('requires a rollback-plan artifact for data or migration risk', () => {
    const result = applyConstraintMutations(baseWorkflow(), {
      tags: ['data', 'migration'],
    });

    const phase = result.workflow.phases.find(
      (candidate) => candidate.id === 'constraint-phase-rollback-plan',
    );
    const node = phase?.nodes[0];

    expect(node).toMatchObject({
      id: 'constraint-node-rollback-plan',
      role: 'rd',
      source: 'constraint',
      explanation: expect.stringContaining('rollback-plan'),
      outputs: ['rollback-plan'],
    });
    expect(node?.gates).toEqual([
      expect.objectContaining({
        id: 'constraint-gate-rollback-plan-schema',
        type: 'schema',
        artifactType: 'rollback-plan',
        source: 'constraint',
        explanation: expect.stringContaining('rollback-plan'),
      }),
    ]);
  });

  it('surfaces soft suggestions without mutating unless explicitly selected', () => {
    const base = baseWorkflow();
    const preview = applyConstraintMutations(base, { tags: [] });

    expect(preview.suggestions).toEqual([
      expect.objectContaining({
        id: 'soft-dry-run-preview',
        source: 'constraint',
        autoMutates: false,
        explanation: expect.stringContaining('dry-run'),
      }),
      expect.objectContaining({
        id: 'soft-audit-log',
        source: 'constraint',
        autoMutates: false,
        explanation: expect.stringContaining('audit'),
      }),
    ]);
    expect(preview.workflow.constraintControls ?? []).toEqual([]);

    const selected = applyConstraintMutations(
      base,
      { tags: [] },
      {
        acceptedSuggestionIds: ['soft-dry-run-preview', 'soft-audit-log'],
      },
    );

    expect(selected.workflow.constraintControls).toEqual([
      expect.objectContaining({
        id: 'constraint-control-dry-run-preview',
        source: 'constraint',
        explanation: expect.stringContaining('dry-run'),
      }),
      expect.objectContaining({
        id: 'constraint-control-audit-log',
        source: 'constraint',
        explanation: expect.stringContaining('audit'),
      }),
    ]);
  });
});

function baseWorkflow(): WorkflowTemplate {
  return {
    id: 'standard-feature',
    name: 'Standard feature',
    phases: [
      {
        id: 'phase-rd',
        name: 'RD implementation',
        nodes: [
          {
            id: 'rd-implementation',
            role: 'rd',
            outputs: ['code-changes'],
            gates: [{ type: 'build' }, { type: 'lint' }],
          },
        ],
      },
      {
        id: 'phase-validation',
        name: 'Validation',
        nodes: [{ id: 'qa-validation', role: 'qa' }],
      },
      {
        id: 'phase-review',
        name: 'Independent review',
        nodes: [{ id: 'reviewer-pass', role: 'reviewer' }],
      },
    ],
  };
}
