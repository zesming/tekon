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
