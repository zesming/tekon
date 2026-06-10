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
      'ci-status',
      'code-changes',
      'delivery-package',
      'demand-card',
      'prd',
      'review-report',
      'rollback-plan',
      'security-report',
      'tech-design',
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
