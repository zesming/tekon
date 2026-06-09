import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  validateWorkflowConstraints,
  type WorkflowTemplate,
} from '../../src/constraint/validator.js';

describe('constraint validator', () => {
  it('reports hard constraint failures for unsafe code-change workflows', () => {
    const workflow: WorkflowTemplate = {
      id: 'unsafe-code-change',
      name: 'Unsafe code change',
      phases: [
        {
          id: 'phase-rd',
          name: 'RD implementation',
          nodes: [
            {
              id: 'rd-implementation',
              role: 'rd',
              outputs: ['code-changes'],
            },
          ],
        },
        {
          id: 'phase-pmo',
          name: 'PMO delivery',
          nodes: [{ id: 'pmo-delivery', role: 'pmo' }],
        },
      ],
    };

    const result = validateWorkflowConstraints(workflow);

    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.id)).toEqual([
      'hard-code-build-lint',
      'hard-independent-reviewer',
      'hard-validation-or-e2e',
    ]);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'hard-code-build-lint',
          severity: 'error',
          explanation: expect.stringContaining('build'),
        }),
        expect.objectContaining({
          id: 'hard-independent-reviewer',
          severity: 'error',
          explanation: expect.stringContaining('reviewer'),
        }),
        expect.objectContaining({
          id: 'hard-validation-or-e2e',
          severity: 'error',
          explanation: expect.stringContaining('validation'),
        }),
      ]),
    );
  });

  it('accepts code-change workflows with build, lint, reviewer, and validation coverage', () => {
    const workflow: WorkflowTemplate = {
      id: 'safe-code-change',
      name: 'Safe code change',
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

    expect(validateWorkflowConstraints(workflow)).toMatchObject({
      valid: true,
      issues: [],
    });
  });

  it('documents the default constraint rule set in constraints.yaml', () => {
    const constraints = readFileSync(
      new URL('../../../../constraints.yaml', import.meta.url),
      'utf8',
    );

    expect(constraints).toContain('hard-code-build-lint');
    expect(constraints).toContain('hard-independent-reviewer');
    expect(constraints).toContain('hard-validation-or-e2e');
    expect(constraints).toContain('conditional-high-risk-human-gate');
    expect(constraints).toContain('conditional-security-review');
    expect(constraints).toContain('conditional-rollback-plan');
    expect(constraints).toContain('soft-dry-run-preview');
    expect(constraints).toContain('soft-audit-log');
  });
});
