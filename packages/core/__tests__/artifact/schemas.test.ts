import { describe, expect, it } from 'vitest';

import {
  agentArtifactManifestSchema,
  artifactPayloadSchemas,
  validateArtifactContent,
  validateArtifactPayload,
} from '../../src/index.js';

describe('artifact schemas', () => {
  it('provides schemas for all built-in artifact types', () => {
    expect(Object.keys(artifactPayloadSchemas).sort()).toEqual([
      'ac-evidence',
      'ci-status',
      'code-changes',
      'code-review',
      'delivery-package',
      'demand-card',
      'demand-review',
      'implementation-plan',
      'prd',
      'process-checkpoint',
      'qa-release-signoff',
      'qa-release-signoff-review',
      'requirement-interface-review',
      'review-report',
      'rollback-plan',
      'security-report',
      'tech-design',
      'technical-review',
      'test-plan',
      'test-plan-review',
      'test-report',
    ]);

    expect(
      validateArtifactPayload('test-report', {
        title: 'Test report',
        body: 'All tests passed.',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Unit tests passed.',
          },
        ],
      }),
    ).toMatchObject({ title: 'Test report' });
    expect(
      validateArtifactPayload('ci-status', {
        title: 'CI status',
        body: 'Remote checks passed.',
        ciStatus: 'passed',
        checkedAt: '2026-06-08T00:00:00.000Z',
        checks: [{ name: 'build', bucket: 'pass' }],
      }),
    ).toMatchObject({ ciStatus: 'passed' });
  });

  it('rejects malformed built-in artifact payloads', () => {
    expect(() =>
      validateArtifactPayload('prd', { title: 'PRD', body: 'Missing AC.' }),
    ).toThrow();
  });

  it('does not allow providers to forge delivery-owned CI status artifacts', () => {
    expect(() =>
      agentArtifactManifestSchema.parse({
        artifacts: [{ type: 'ci-status', path: 'ci.json' }],
      }),
    ).toThrow();
  });

  it('validates semantic acceptance and security payloads', () => {
    expect(
      validateArtifactPayload('prd', {
        title: 'PRD',
        body: 'Feature requirements.',
        acceptanceCriteria: [
          { id: 'AC-1', description: 'User can retry failed tasks.' },
        ],
      }),
    ).toMatchObject({ acceptanceCriteria: [{ id: 'AC-1' }] });

    expect(
      validateArtifactPayload('security-report', {
        title: 'Security scan',
        body: 'No high risk findings.',
        securityFindings: [],
      }),
    ).toMatchObject({ securityFindings: [] });
  });

  it('validates role-scoped independent review, AC evidence, and QA signoff payloads', () => {
    expect(
      validateArtifactPayload('technical-review', {
        title: 'RD technical review',
        body: 'Implementation plan is reasonable.',
        reviewScope: 'technical-design',
        reviewProcess: {
          mode: 'independent-process',
          reviewerId: 'rd-reviewer-process-1',
          reviewerRole: 'rd',
          targetNodeId: 'rd-implementation-plan',
          targetRole: 'rd',
        },
        decision: 'approved',
      }),
    ).toMatchObject({
      reviewScope: 'technical-design',
      decision: 'approved',
    });

    expect(
      validateArtifactPayload('ac-evidence', {
        title: 'AC evidence',
        body: 'All acceptance criteria are verified.',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Unit test output covers AC-1.',
            gateResultIds: ['gate_test'],
          },
        ],
      }),
    ).toMatchObject({ criteriaEvidence: [{ criterionId: 'AC-1' }] });

    expect(
      validateArtifactPayload('qa-release-signoff', {
        title: 'QA release signoff',
        body: 'The tested commit is the delivered commit.',
        targetRef: 'sha:abc123',
        validatedRef: 'sha:abc123',
        overallStatus: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'QA validation passed on sha:abc123.',
          },
        ],
      }),
    ).toMatchObject({ overallStatus: 'passed' });
  });

  it('normalizes provider-style invalid finding owner roles without changing review scope fields', () => {
    expect(
      validateArtifactContent(
        'demand-review',
        JSON.stringify({
          title: 'PM demand review',
          body: '需求清晰，但需要人类 owner 跟进风险说明。',
          reviewScope: 'demand-quality',
          reviewProcess: {
            mode: 'independent-process',
            reviewerId: 'pm-reviewer',
            reviewerRole: 'pm',
            targetNodeId: 'pm-demand-card',
            targetRole: 'pm',
          },
          decision: 'approved',
          findings: [
            {
              severity: 'important',
              ownerRole: 'human owner / PMO',
              message: '需要在最终 review surface 补齐风险说明。',
            },
          ],
        }),
      ),
    ).toMatchObject({
      reviewScope: 'demand-quality',
      reviewProcess: {
        reviewerRole: 'pm',
        targetRole: 'pm',
      },
      findings: [
        {
          severity: 'important',
          message: expect.stringContaining('human owner / PMO'),
        },
      ],
    });
  });

  it('requires PMO process checkpoint gate evidence to carry stable gate keys', () => {
    expect(() =>
      validateArtifactPayload('process-checkpoint', {
        title: 'PMO checkpoint',
        body: 'Process is complete.',
        requiredNodes: [{ nodeId: 'pm-demand-card', status: 'passed' }],
        humanDecisionEvidence: { pending: 0 },
        gateEvidence: [
          {
            nodeId: 'pm-demand-card',
            gateType: 'schema',
            status: 'passed',
          },
        ],
      }),
    ).toThrow();

    expect(
      validateArtifactPayload('process-checkpoint', {
        title: 'PMO checkpoint',
        body: 'Process is complete.',
        requiredNodes: [{ nodeId: 'pm-demand-card', status: 'passed' }],
        humanDecisionEvidence: { pending: 0 },
        gateEvidence: [
          {
            nodeId: 'pm-demand-card',
            gateType: 'schema',
            gateKey: '00:schema:artifact=demand-card',
            status: 'passed',
          },
        ],
      }),
    ).toMatchObject({
      gateEvidence: [
        {
          gateKey: '00:schema:artifact=demand-card',
        },
      ],
    });
  });

  it('normalizes provider-style code changes artifacts into a readable payload', () => {
    expect(
      validateArtifactContent(
        'code-changes',
        JSON.stringify({
          type: 'code-changes',
          summary: '同步补充 Codex provider smoke artifact 输出目录诊断说明',
          changedFiles: [
            {
              path: 'docs/manual/codex-provider-smoke.md',
              changes: ['补充 TEKON_OUTPUT_DIR 诊断说明。'],
            },
          ],
          verification: [
            {
              command: 'git diff --check',
              result: 'exit 0',
            },
          ],
        }),
      ),
    ).toMatchObject({
      title: 'Code changes',
      body: expect.stringContaining('docs/manual/codex-provider-smoke.md'),
      summary: '同步补充 Codex provider smoke artifact 输出目录诊断说明',
    });
  });

  it('normalizes provider-style acceptance criteria for demand cards', () => {
    expect(
      validateArtifactContent(
        'demand-card',
        JSON.stringify({
          title: '补充 Codex provider smoke 文档中的 artifact 输出目录诊断说明',
          body: '同步更新 Markdown 源稿与 HTML 审阅版。',
          acceptance_criteria: [
            {
              id: 'AC-1',
              criterion:
                'Markdown 源稿包含 --add-dir <TEKON_OUTPUT_DIR> 说明。',
              verification:
                'QA 在相关 Markdown 文件中搜索 --add-dir <TEKON_OUTPUT_DIR>。',
            },
          ],
        }),
      ),
    ).toMatchObject({
      acceptanceCriteria: [
        {
          id: 'AC-1',
          description: 'Markdown 源稿包含 --add-dir <TEKON_OUTPUT_DIR> 说明。',
        },
      ],
    });
  });

  it('normalizes provider-style QA test plans into required schema fields', () => {
    expect(
      validateArtifactContent(
        'test-plan',
        JSON.stringify({
          title: 'QA 测试方案',
          body: '验证长程任务产物进展观测。',
          sourceArtifactsReviewed: [
            {
              alias: 'demand',
              path: '.tekon/runs/run_1/artifacts/demand-card.v1.md',
            },
            {
              alias: 'implementation-plan',
              path: '.tekon/runs/run_1/artifacts/implementation-plan.v1.md',
            },
          ],
          testScenarios: [
            {
              id: 'QA-CG-001',
              name: '受控 outputDir 文件变化刷新 progress JSON',
              type: 'targeted-regression',
            },
          ],
        }),
      ),
    ).toMatchObject({
      testBasis: [
        'demand: .tekon/runs/run_1/artifacts/demand-card.v1.md',
        'implementation-plan: .tekon/runs/run_1/artifacts/implementation-plan.v1.md',
      ],
      testCases: [
        {
          id: 'QA-CG-001',
          description: '受控 outputDir 文件变化刷新 progress JSON',
        },
      ],
    });
  });

  it('normalizes provider-style QA validation reports into schema-compatible evidence', () => {
    expect(
      validateArtifactContent(
        'test-report',
        JSON.stringify({
          title: 'QA Test Report',
          body: 'QA validation completed.',
          summary: {
            scopedBlockingDefects: 0,
            recommendation: 'Proceed to controlled delivery review.',
          },
          criteriaEvidence: [
            {
              id: 'AC-1',
              status: 'passed_with_delivery_followup',
              evidenceSummary: 'Focused CommandGateway regression passed.',
              outputPaths: ['logs/focused-command-gateway.log'],
            },
          ],
        }),
      ),
    ).toMatchObject({
      summary:
        'scopedBlockingDefects: 0; recommendation: Proceed to controlled delivery review.',
      criteriaEvidence: [
        {
          criterionId: 'AC-1',
          status: 'passed',
          evidence: 'Focused CommandGateway regression passed.',
          outputPaths: ['logs/focused-command-gateway.log'],
        },
      ],
    });

    expect(
      validateArtifactContent(
        'ac-evidence',
        JSON.stringify({
          title: 'AC Evidence',
          body: 'All acceptance criteria are verified.',
          criteriaEvidence: [
            {
              id: 'AC-4',
              status: 'passed_with_manual_delivery_boundary',
              criterion: 'High-risk changes require controlled delivery.',
              coverage: 'QA verified no merge or release was performed.',
              evidenceSummary:
                'Manual delivery boundary is documented in review evidence.',
              gateResultIds: ['gate_security'],
              artifactIds: ['qa-validation:test-report'],
              outputPaths: ['docs/reviews/long-task-progress.md'],
            },
          ],
        }),
      ),
    ).toMatchObject({
      criteriaEvidence: [
        {
          criterionId: 'AC-4',
          status: 'passed',
          evidence:
            'Manual delivery boundary is documented in review evidence.',
          gateResultIds: ['gate_security'],
          artifactIds: ['qa-validation:test-report'],
          outputPaths: ['docs/reviews/long-task-progress.md'],
        },
      ],
    });
  });

  it('normalizes provider-style QA evidence objects with nested anchors', () => {
    expect(
      validateArtifactContent(
        'ac-evidence',
        JSON.stringify({
          title: 'AC Evidence',
          body: 'All acceptance criteria are verified.',
          criteriaEvidence: [
            {
              criterionId: 'AC-1',
              status: 'passed',
              evidence: {
                summary: 'Focused regression passed with anchored evidence.',
                outputPaths: ['logs/fresh-focused-command-gateway.log'],
                artifactIds: ['qa-validation:test-report'],
                gateResultIds: ['gate_build'],
              },
            },
          ],
        }),
      ),
    ).toMatchObject({
      criteriaEvidence: [
        {
          criterionId: 'AC-1',
          status: 'passed',
          evidence: 'Focused regression passed with anchored evidence.',
          outputPaths: ['logs/fresh-focused-command-gateway.log'],
          artifactIds: ['qa-validation:test-report'],
          gateResultIds: ['gate_build'],
        },
      ],
    });
  });

  it('keeps provider-style QA validation evidence normalization narrow', () => {
    for (const payload of [
      {
        title: 'AC Evidence',
        body: 'Criterion text alone is not validation evidence.',
        criteriaEvidence: [
          {
            id: 'AC-1',
            status: 'passed',
            criterion: 'The user can review long task progress.',
          },
        ],
      },
      {
        title: 'AC Evidence',
        body: 'Missing status is not evidence.',
        criteriaEvidence: [
          {
            id: 'AC-1',
            evidenceSummary: 'Focused regression passed.',
          },
        ],
      },
      {
        title: 'AC Evidence',
        body: 'Evidence object without summary is not validation evidence.',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: {
              outputPaths: ['logs/fresh-focused-command-gateway.log'],
            },
          },
        ],
      },
      {
        title: 'AC Evidence',
        body: 'Ambiguous status must not be treated as passed.',
        criteriaEvidence: [
          {
            id: 'AC-1',
            status: 'bypassed',
            evidenceSummary: 'This was skipped.',
          },
        ],
      },
      {
        title: 'AC Evidence',
        body: 'Negated status must not be treated as passed.',
        criteriaEvidence: [
          {
            id: 'AC-1',
            status: 'not_passed',
            evidenceSummary: 'Validation did not pass.',
          },
        ],
      },
      {
        title: 'AC Evidence',
        body: 'Unblocked status must not be treated as blocked.',
        criteriaEvidence: [
          {
            id: 'AC-1',
            status: 'unblocked',
            evidenceSummary: 'No longer blocked.',
          },
        ],
      },
    ]) {
      expect(() =>
        validateArtifactContent('ac-evidence', JSON.stringify(payload)),
      ).toThrow();
    }
  });

  it('keeps provider-style acceptance criteria normalization narrow', () => {
    const invalidCriteria = [
      [],
      [{ id: '', criterion: 'Missing id.' }],
      [{ id: 'AC-1', criterion: '' }],
      [{ id: 'AC-1' }],
      ['AC-1'],
    ];

    for (const acceptance_criteria of invalidCriteria) {
      expect(() =>
        validateArtifactContent(
          'demand-card',
          JSON.stringify({
            title: 'Demand card',
            body: 'Scoped documentation update.',
            acceptance_criteria,
          }),
        ),
      ).toThrow();
    }

    expect(() =>
      validateArtifactContent(
        'demand-card',
        [
          '---',
          'title: Demand card',
          'body: Scoped documentation update.',
          'acceptance_criteria:',
          '  - id: AC-1',
          '    criterion: Document output directory diagnostics.',
          '---',
          '',
        ].join('\n'),
      ),
    ).toThrow();

    const testReport = validateArtifactContent(
      'test-report',
      JSON.stringify({
        title: 'Test report',
        body: 'Provider-style criteria are not test evidence.',
        acceptance_criteria: [
          {
            id: 'AC-1',
            criterion: 'This should not satisfy criteriaEvidence.',
          },
        ],
      }),
    );
    expect(testReport).not.toHaveProperty('acceptanceCriteria');
    expect(testReport).not.toHaveProperty('criteriaEvidence');
  });

  it('rejects non-provider-style code changes artifacts without title and body', () => {
    for (const payload of [
      {},
      { type: 'code-changes' },
      { changedFiles: [{}] },
      { verification: [{}] },
      {
        changedFiles: ['  '],
        verification: [{ command: ' ', result: ' ' }],
      },
    ]) {
      expect(() =>
        validateArtifactContent('code-changes', JSON.stringify(payload)),
      ).toThrow();
    }
  });

  it('does not normalize provider-style fields for other artifact types', () => {
    expect(() =>
      validateArtifactContent(
        'tech-design',
        JSON.stringify({
          summary: '技术方案摘要',
          changedFiles: ['docs/manual/codex-provider-smoke.md'],
        }),
      ),
    ).toThrow();
  });

  it('does not normalize provider-style code changes fields in YAML front matter', () => {
    expect(() =>
      validateArtifactContent(
        'code-changes',
        [
          '---',
          'summary: 同步补充 Codex provider smoke artifact 输出目录诊断说明',
          'changedFiles:',
          '  - docs/manual/codex-provider-smoke.md',
          '---',
          '',
        ].join('\n'),
      ),
    ).toThrow();
  });
});
