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
      }),
    ).toMatchObject({ title: 'Test report' });
  });

  it('rejects malformed built-in artifact payloads', () => {
    expect(() => validateArtifactPayload('prd', { title: '' })).toThrow();
  });
});
