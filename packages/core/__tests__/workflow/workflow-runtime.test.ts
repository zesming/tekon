import { describe, expect, it } from 'vitest';

import {
  scopedId,
  gatesWithStableKeys,
  stableGateKey,
  resolveReviewTargetNodeByHeuristic,
  isChangesRequested,
  resolveMaxReworkAttempts,
} from '../../src/workflow/workflow-runtime.js';

// ---------------------------------------------------------------------------
// scopedId
// ---------------------------------------------------------------------------
describe('scopedId', () => {
  it('joins runId and id with an underscore', () => {
    expect(scopedId('run_1', 'phase_rd')).toBe('run_1_phase_rd');
  });

  it('handles empty id', () => {
    expect(scopedId('run_1', '')).toBe('run_1_');
  });

  it('handles UUID-style runId', () => {
    expect(scopedId('550e8400-e29b-41d4-a716-446655440000', 'node_1')).toBe(
      '550e8400-e29b-41d4-a716-446655440000_node_1',
    );
  });

  it('produces distinct IDs for different runIds with same local id', () => {
    expect(scopedId('run_a', 'node_1')).not.toBe(scopedId('run_b', 'node_1'));
  });

  it('produces distinct IDs for same runId with different local ids', () => {
    expect(scopedId('run_1', 'node_a')).not.toBe(scopedId('run_1', 'node_b'));
  });
});

// ---------------------------------------------------------------------------
// stableGateKey
// ---------------------------------------------------------------------------
describe('stableGateKey', () => {
  it('produces a deterministic key from gate type and index', () => {
    expect(stableGateKey({ type: 'build' }, 0)).toBe('00:build');
    expect(stableGateKey({ type: 'build' }, 1)).toBe('01:build');
    expect(stableGateKey({ type: 'build' }, 10)).toBe('10:build');
  });

  it('zero-pads the index to two digits', () => {
    expect(stableGateKey({ type: 'lint' }, 0)).toMatch(/^00:/u);
    expect(stableGateKey({ type: 'lint' }, 9)).toMatch(/^09:/u);
    expect(stableGateKey({ type: 'lint' }, 99)).toMatch(/^99:/u);
  });

  it('includes artifactType when present', () => {
    expect(stableGateKey({ type: 'schema', artifactType: 'prd' }, 0)).toBe(
      '00:schema:artifact=prd',
    );
  });

  it('includes commandRef when present', () => {
    expect(stableGateKey({ type: 'build', commandRef: 'typecheck' }, 0)).toBe(
      '00:build:commandRef=typecheck',
    );
  });

  it('appends "skipped" when skipReason is set', () => {
    expect(stableGateKey({ type: 'test', skipReason: 'not applicable' }, 2)).toBe(
      '02:test:skipped',
    );
  });

  it('includes all fields in order when multiple are present', () => {
    const key = stableGateKey(
      {
        type: 'e2e-pass',
        artifactType: 'test-report',
        commandRef: 'e2e',
      },
      5,
    );
    expect(key).toBe('05:e2e-pass:artifact=test-report:commandRef=e2e');
  });

  it('is idempotent for equivalent gate shapes', () => {
    const gate = { type: 'security-scan' as const, commandRef: 'security' as const };
    expect(stableGateKey(gate, 2)).toBe(stableGateKey(gate, 2));
  });
});

// ---------------------------------------------------------------------------
// gatesWithStableKeys
// ---------------------------------------------------------------------------
describe('gatesWithStableKeys', () => {
  it('assigns stable keys to an array of gates', () => {
    const gates = [
      { type: 'build' as const, requiresHumanApproval: false, maxRetries: 0 },
      { type: 'lint' as const, requiresHumanApproval: false, maxRetries: 0 },
    ];
    const result = gatesWithStableKeys(gates, 'node_1');
    expect(result).toHaveLength(2);
    expect(result[0].gateKey).toBe('00:build');
    expect(result[1].gateKey).toBe('01:lint');
  });

  it('preserves existing gateKey if already set', () => {
    const gates = [
      { type: 'build' as const, gateKey: 'custom-key', requiresHumanApproval: false, maxRetries: 0 },
      { type: 'test' as const, requiresHumanApproval: false, maxRetries: 0 },
    ];
    const result = gatesWithStableKeys(gates, 'node_1');
    expect(result[0].gateKey).toBe('custom-key');
    expect(result[1].gateKey).toBe('01:test');
  });

  it('throws on duplicate gate keys', () => {
    const gates = [
      { type: 'build' as const, gateKey: 'same', requiresHumanApproval: false, maxRetries: 0 },
      { type: 'lint' as const, gateKey: 'same', requiresHumanApproval: false, maxRetries: 0 },
    ];
    expect(() => gatesWithStableKeys(gates, 'my-node')).toThrow(/duplicate gateKey/u);
  });

  it('includes the nodeId in the duplicate error message', () => {
    const gates = [
      { type: 'test' as const, gateKey: 'dup', requiresHumanApproval: false, maxRetries: 0 },
      { type: 'lint' as const, gateKey: 'dup', requiresHumanApproval: false, maxRetries: 0 },
    ];
    expect(() => gatesWithStableKeys(gates, 'critical-node-42')).toThrow(/critical-node-42/u);
  });

  it('returns empty array when given empty gates', () => {
    expect(gatesWithStableKeys([], 'node_1')).toEqual([]);
  });

  it('preserves all original gate fields when assigning keys', () => {
    const gate = {
      type: 'e2e-pass' as const,
      requiresHumanApproval: true,
      maxRetries: 3,
      timeoutMs: 30000,
      artifactType: 'test-report' as const,
    };
    const [result] = gatesWithStableKeys([gate], 'node_1');
    expect(result).toMatchObject({
      type: 'e2e-pass',
      requiresHumanApproval: true,
      maxRetries: 3,
      timeoutMs: 30000,
      artifactType: 'test-report',
    });
    expect(result.gateKey).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// resolveReviewTargetNodeByHeuristic
// ---------------------------------------------------------------------------
describe('resolveReviewTargetNodeByHeuristic', () => {
  it('finds the last upstream passed node', () => {
    const nodes = [
      { id: 'run_1_pm', status: 'passed' },
      { id: 'run_1_rd', status: 'passed' },
      { id: 'run_1_qa', status: 'passed' },
      { id: 'run_1_reviewer', status: 'running' },
    ];
    expect(resolveReviewTargetNodeByHeuristic(nodes, 'run_1_reviewer')).toBe('run_1_qa');
  });

  it('returns null when no upstream passed node exists', () => {
    const nodes = [
      { id: 'run_1_blocked', status: 'blocked' },
      { id: 'run_1_reviewer', status: 'running' },
    ];
    expect(resolveReviewTargetNodeByHeuristic(nodes, 'run_1_reviewer')).toBeNull();
  });

  it('returns null when review node is the only node', () => {
    const nodes = [{ id: 'run_1_reviewer', status: 'running' }];
    expect(resolveReviewTargetNodeByHeuristic(nodes, 'run_1_reviewer')).toBeNull();
  });

  it('returns null when review node is not found in the list', () => {
    const nodes = [{ id: 'run_1_rd', status: 'passed' }];
    expect(resolveReviewTargetNodeByHeuristic(nodes, 'nonexistent')).toBeNull();
  });

  it('skips non-passed upstream nodes (blocked, needs-revision, running)', () => {
    const nodes = [
      { id: 'run_1_rd', status: 'blocked' },
      { id: 'run_1_qa', status: 'needs-revision' },
      { id: 'run_1_pm', status: 'passed' },
      { id: 'run_1_another', status: 'running' },
      { id: 'run_1_reviewer', status: 'running' },
    ];
    expect(resolveReviewTargetNodeByHeuristic(nodes, 'run_1_reviewer')).toBe('run_1_pm');
  });

  it('handles empty nodes array', () => {
    expect(resolveReviewTargetNodeByHeuristic([], 'any')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// isChangesRequested
// ---------------------------------------------------------------------------
describe('isChangesRequested', () => {
  it('returns true for changes-requested on independent-review gate', () => {
    expect(isChangesRequested('changes-requested', 'independent-review')).toBe(true);
  });

  it('returns false for changes-requested on non-independent-review gate', () => {
    expect(isChangesRequested('changes-requested', 'schema')).toBe(false);
    expect(isChangesRequested('changes-requested', 'build')).toBe(false);
    expect(isChangesRequested('changes-requested', 'lint')).toBe(false);
    expect(isChangesRequested('changes-requested', 'human')).toBe(false);
  });

  it('returns false for non-changes-requested classification on independent-review', () => {
    expect(isChangesRequested('review-not-approved', 'independent-review')).toBe(false);
    expect(isChangesRequested('build-failure', 'independent-review')).toBe(false);
  });

  it('returns false for null or undefined classification', () => {
    expect(isChangesRequested(null, 'independent-review')).toBe(false);
    expect(isChangesRequested(undefined, 'independent-review')).toBe(false);
  });

  it('returns false for empty string classification', () => {
    expect(isChangesRequested('', 'independent-review')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// resolveMaxReworkAttempts
// ---------------------------------------------------------------------------
describe('resolveMaxReworkAttempts', () => {
  it('defaults to 5 when maxRetries is 0', () => {
    expect(resolveMaxReworkAttempts(0)).toBe(5);
  });

  it('defaults to 5 when maxRetries is negative', () => {
    expect(resolveMaxReworkAttempts(-1)).toBe(5);
    expect(resolveMaxReworkAttempts(-100)).toBe(5);
  });

  it('respects positive maxRetries', () => {
    expect(resolveMaxReworkAttempts(3)).toBe(3);
    expect(resolveMaxReworkAttempts(1)).toBe(1);
    expect(resolveMaxReworkAttempts(10)).toBe(10);
  });
});
