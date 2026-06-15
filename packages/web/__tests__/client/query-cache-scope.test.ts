import { describe, it, expect } from 'vitest';
import { QueryCache } from '../../src/client/lib/query-cache.js';
import { authScope, queryKeys } from '../../src/client/lib/query-keys.js';

// ---------------------------------------------------------------------------
// clearByScope
// ---------------------------------------------------------------------------

describe('QueryCache.clearByScope', () => {
  it('removes entries whose keys end with the given scope', () => {
    const cache = new QueryCache();
    const scope = authScope('token-A');

    // Populate scoped entries
    cache.set(queryKeys.projectOverview(scope), { name: 'proj' });
    cache.set(queryKeys.reviewDetail('wf_1', scope), { status: 'ok' });

    // Populate a non-scoped entry
    cache.set(queryKeys.auditLog('wf_1'), { events: [] });

    // Clear by scope
    cache.clearByScope(scope);

    // Scoped entries should be gone
    expect(cache.get(queryKeys.projectOverview(scope))).toBeUndefined();
    expect(cache.get(queryKeys.reviewDetail('wf_1', scope))).toBeUndefined();

    // Non-scoped entry should remain
    expect(cache.get(queryKeys.auditLog('wf_1'))).toBeDefined();
  });

  it('preserves entries with a different scope', () => {
    const cache = new QueryCache();
    const scopeA = authScope('token-A');
    const scopeB = authScope('token-B');

    cache.set(queryKeys.projectOverview(scopeA), { name: 'A' });
    cache.set(queryKeys.projectOverview(scopeB), { name: 'B' });

    // Clear scope A
    cache.clearByScope(scopeA);

    expect(cache.get(queryKeys.projectOverview(scopeA))).toBeUndefined();
    expect(cache.get(queryKeys.projectOverview(scopeB))).toBeDefined();
    expect(cache.get(queryKeys.projectOverview(scopeB))!.data).toEqual({ name: 'B' });
  });

  it('clears matching in-flight entries', () => {
    const cache = new QueryCache();
    const scope = authScope('token-A');

    const key = queryKeys.projectOverview(scope);
    const pending = new Promise(() => undefined); // never resolves
    cache.setInFlight(key, pending);

    expect(cache.getInFlight(key)).toBe(pending);

    cache.clearByScope(scope);

    expect(cache.getInFlight(key)).toBeUndefined();
  });

  it('does nothing when called with an empty scope', () => {
    const cache = new QueryCache();
    cache.set('some.key', { data: true });

    cache.clearByScope('');

    expect(cache.get('some.key')).toBeDefined();
  });

  it('does not affect non-scoped static keys', () => {
    const cache = new QueryCache();
    const scope = authScope('token-A');

    cache.set(queryKeys.roles(), [{ id: 'pm' }]);
    cache.set(queryKeys.workflows(), [{ id: 'standard-delivery' }]);
    cache.set(queryKeys.projectOverview(scope), { name: 'proj' });

    cache.clearByScope(scope);

    expect(cache.get(queryKeys.roles())).toBeDefined();
    expect(cache.get(queryKeys.workflows())).toBeDefined();
    expect(cache.get(queryKeys.projectOverview(scope))).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clearAllInFlight
// ---------------------------------------------------------------------------

describe('QueryCache.clearAllInFlight', () => {
  it('clears all pending promises regardless of key', () => {
    const cache = new QueryCache();
    const scope = authScope('token-A');

    const key1 = queryKeys.projectOverview(scope);
    const key2 = queryKeys.auditLog('wf_1');
    const pending1 = new Promise(() => undefined);
    const pending2 = new Promise(() => undefined);

    cache.setInFlight(key1, pending1);
    cache.setInFlight(key2, pending2);

    expect(cache.getInFlight(key1)).toBe(pending1);
    expect(cache.getInFlight(key2)).toBe(pending2);

    cache.clearAllInFlight();

    expect(cache.getInFlight(key1)).toBeUndefined();
    expect(cache.getInFlight(key2)).toBeUndefined();
  });

  it('does not affect cached data', () => {
    const cache = new QueryCache();
    cache.set('some.key', { value: 42 });

    cache.clearAllInFlight();

    expect(cache.get('some.key')).toBeDefined();
    expect(cache.get('some.key')!.data).toEqual({ value: 42 });
  });
});

// ---------------------------------------------------------------------------
// Token change flow integration
// ---------------------------------------------------------------------------

describe('Token change flow', () => {
  it('old scope is cleared and new scope is fresh after token change', () => {
    const cache = new QueryCache();

    const oldToken = 'old-token';
    const newToken = 'new-token';
    const oldScope = authScope(oldToken);
    const newScope = authScope(newToken);

    // Simulate old session: populate cache with old scope
    cache.set(queryKeys.projectOverview(oldScope), { name: 'old-proj' });
    cache.set(queryKeys.reviewDetail('wf_1', oldScope), { status: 'old-review' });
    cache.set(queryKeys.gateResults('wf_1', oldScope), { gates: [] });

    // Non-scoped data (should survive token change)
    cache.set(queryKeys.auditLog('wf_1'), { events: ['event1'] });

    // Simulate in-flight request from old session
    const oldPending = new Promise(() => undefined);
    cache.setInFlight(queryKeys.runList(oldScope), oldPending);

    // ── Token changes ──
    // Step 1: Clear old scope
    cache.clearByScope(oldScope);
    // Step 2: Clear all in-flight
    cache.clearAllInFlight();

    // Old scoped data should be gone
    expect(cache.get(queryKeys.projectOverview(oldScope))).toBeUndefined();
    expect(cache.get(queryKeys.reviewDetail('wf_1', oldScope))).toBeUndefined();
    expect(cache.get(queryKeys.gateResults('wf_1', oldScope))).toBeUndefined();

    // In-flight from old session should be cleared
    expect(cache.getInFlight(queryKeys.runList(oldScope))).toBeUndefined();

    // Non-scoped data should survive
    expect(cache.get(queryKeys.auditLog('wf_1'))).toBeDefined();
    expect(cache.get(queryKeys.auditLog('wf_1'))!.data).toEqual({ events: ['event1'] });

    // ── New session: fresh cache ──
    cache.set(queryKeys.projectOverview(newScope), { name: 'new-proj' });
    expect(cache.get(queryKeys.projectOverview(newScope))).toBeDefined();
    expect(cache.get(queryKeys.projectOverview(newScope))!.data).toEqual({ name: 'new-proj' });

    // Old scope key still gone (no cross-contamination)
    expect(cache.get(queryKeys.projectOverview(oldScope))).toBeUndefined();
  });

  it('prefix-based invalidate still works with scoped keys', () => {
    const cache = new QueryCache();
    const scope = authScope('my-token');

    cache.set(queryKeys.reviewDetail('wf_1', scope), { v: 1 });
    cache.set(queryKeys.reviewDetail('wf_2', scope), { v: 2 });

    // Invalidate all review keys by prefix
    cache.invalidate('review.');

    // Both should be marked stale but data preserved
    const r1 = cache.get(queryKeys.reviewDetail('wf_1', scope));
    const r2 = cache.get(queryKeys.reviewDetail('wf_2', scope));
    expect(r1).toBeDefined();
    expect(r2).toBeDefined();
    expect(r1!.stale).toBe(true);
    expect(r2!.stale).toBe(true);
    expect(r1!.data).toEqual({ v: 1 });
    expect(r2!.data).toEqual({ v: 2 });
  });
});
