import { describe, it, expect } from 'vitest';
import { authScope, queryKeys } from '../../src/client/lib/query-keys.js';

// ---------------------------------------------------------------------------
// authScope
// ---------------------------------------------------------------------------

describe('authScope', () => {
  it('returns "anon" for null token', () => {
    expect(authScope(null)).toBe('anon');
  });

  it('returns "anon" for empty string token', () => {
    expect(authScope('')).toBe('anon');
  });

  it('produces consistent hashes for the same token', () => {
    const token = 'test-token-abc123';
    expect(authScope(token)).toBe(authScope(token));
  });

  it('produces different scopes for different tokens', () => {
    expect(authScope('token-a')).not.toBe(authScope('token-b'));
  });

  it('returns a string representation of a number for non-empty tokens', () => {
    const scope = authScope('some-real-token');
    expect(scope).not.toBe('anon');
    // Should be a numeric string (the hash result)
    expect(Number.isFinite(Number(scope))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// queryKeys
// ---------------------------------------------------------------------------

describe('queryKeys', () => {
  describe('auth-scoped keys', () => {
    it('projectOverview includes scope', () => {
      expect(queryKeys.projectOverview('abc')).toBe('project.overview.abc');
    });

    it('projectDetail includes projectId and scope', () => {
      expect(queryKeys.projectDetail('proj-1', 'abc')).toBe('project.detail.proj-1.abc');
    });

    it('runList includes scope', () => {
      expect(queryKeys.runList('abc')).toBe('run.list.abc');
    });

    it('runDetail includes runId and scope', () => {
      expect(queryKeys.runDetail('wf_123', 'abc')).toBe('run.detail.wf_123.abc');
    });

    it('gateResults includes runId and scope', () => {
      expect(queryKeys.gateResults('wf_123', 'abc')).toBe('gate.results.wf_123.abc');
    });

    it('reviewDetail includes runId and scope', () => {
      expect(queryKeys.reviewDetail('wf_123', 'abc')).toBe('review.wf_123.abc');
    });

    it('deliveryCiStatus includes runId and scope', () => {
      expect(queryKeys.deliveryCiStatus('wf_123', 'abc')).toBe('delivery.ciStatus.wf_123.abc');
    });
  });

  describe('session-independent keys', () => {
    it('artifacts includes runId and defaults nodeId to "all"', () => {
      expect(queryKeys.artifacts('wf_123')).toBe('artifacts.wf_123.all');
    });

    it('artifacts includes explicit nodeId', () => {
      expect(queryKeys.artifacts('wf_123', 'node-1')).toBe('artifacts.wf_123.node-1');
    });

    it('auditLog includes runId', () => {
      expect(queryKeys.auditLog('wf_123')).toBe('audit.wf_123');
    });

    it('readiness includes runId', () => {
      expect(queryKeys.readiness('wf_123')).toBe('readiness.wf_123');
    });

    it('deliveryStatus includes runId', () => {
      expect(queryKeys.deliveryStatus('wf_123')).toBe('delivery.wf_123');
    });

    it('humanDecisions includes runId', () => {
      expect(queryKeys.humanDecisions('wf_123')).toBe('human.decisions.wf_123');
    });

    it('progress includes runId', () => {
      expect(queryKeys.progress('wf_123')).toBe('progress.wf_123');
    });

    it('draftShapeDetail includes shapePath', () => {
      expect(queryKeys.draftShapeDetail('/path/to/shape')).toBe('draftShape.detail./path/to/shape');
    });

    it('roles returns static key', () => {
      expect(queryKeys.roles()).toBe('roles');
    });

    it('workflows returns static key', () => {
      expect(queryKeys.workflows()).toBe('workflows');
    });

    it('settings returns static key', () => {
      expect(queryKeys.settings()).toBe('settings');
    });
  });

  describe('scope isolation', () => {
    it('same resource with different scopes produces different keys', () => {
      const key1 = queryKeys.reviewDetail('wf_123', 'scope-a');
      const key2 = queryKeys.reviewDetail('wf_123', 'scope-b');
      expect(key1).not.toBe(key2);
    });

    it('anon-scoped keys are distinct from authenticated keys', () => {
      const anonKey = queryKeys.projectOverview('anon');
      const authKey = queryKeys.projectOverview(authScope('real-token'));
      expect(anonKey).not.toBe(authKey);
    });
  });
});
