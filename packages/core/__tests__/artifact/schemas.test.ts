import { describe, expect, it } from 'vitest';

import {
  artifactPayloadSchemas,
  validateArtifactPayload,
} from '../../src/index.js';

describe('artifact schemas', () => {
  it('provides schemas for all built-in artifact types', () => {
    expect(Object.keys(artifactPayloadSchemas).sort()).toEqual([
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
  });

  it('rejects malformed built-in artifact payloads', () => {
    expect(() =>
      validateArtifactPayload('prd', { title: 'PRD', body: 'Missing AC.' }),
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
});
