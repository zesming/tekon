import { describe, expect, it } from 'vitest';

import {
  assertSuccessfulAgentRun,
  defaultBuiltInRolesDir,
  defaultCommandPolicy,
  gatesWithStableKeys,
  isChangesRequested,
  makeSyntheticLease,
  resolveMaxReworkAttempts,
  resolveReviewTargetNodeByHeuristic,
  scopedId,
  stableGateKey,
  createWorkflowEngine,
  type WorkflowEngine,
} from '../../src/index.js';

// ---------------------------------------------------------------------------
// assertSuccessfulAgentRun
// ---------------------------------------------------------------------------
describe('assertSuccessfulAgentRun', () => {
  it('returns void for a successful agent result (exitCode 0, not timed out)', () => {
    expect(() =>
      assertSuccessfulAgentRun({
        provider: 'claude-code',
        exitCode: 0,
        durationMs: 5000,
        outputFiles: ['out.json'],
        timedOut: false,
      }),
    ).not.toThrow();
  });

  it('throws when the agent timed out', () => {
    expect(() =>
      assertSuccessfulAgentRun({
        provider: 'codex',
        exitCode: 0,
        durationMs: 60000,
        outputFiles: [],
        timedOut: true,
      }),
    ).toThrow(/agent timed out/u);
  });

  it('throws when the agent has a non-zero exit code', () => {
    expect(() =>
      assertSuccessfulAgentRun({
        provider: 'custom',
        exitCode: 1,
        durationMs: 3000,
        outputFiles: [],
        timedOut: false,
      }),
    ).toThrow(/agent failed/u);
  });

  it('throws when the agent has a null exit code (treated as non-zero)', () => {
    expect(() =>
      assertSuccessfulAgentRun({
        provider: 'claude-code',
        exitCode: null,
        durationMs: 1000,
        outputFiles: [],
        timedOut: false,
      }),
    ).toThrow(/agent failed/u);
  });

  it('includes the provider name in error messages', () => {
    expect(() =>
      assertSuccessfulAgentRun({
        provider: 'mock',
        exitCode: null,
        durationMs: 1,
        outputFiles: [],
        timedOut: false,
      }),
    ).toThrow(/provider=mock/u);

    expect(() =>
      assertSuccessfulAgentRun({
        provider: 'codex',
        exitCode: 2,
        durationMs: 10,
        outputFiles: [],
        timedOut: false,
      }),
    ).toThrow(/provider=codex/u);
  });
});

// ---------------------------------------------------------------------------
// scopedId
// ---------------------------------------------------------------------------
describe('scopedId', () => {
  it('joins runId and id with an underscore', () => {
    expect(scopedId('run_abc', 'node_x')).toBe('run_abc_node_x');
  });

  it('handles empty id', () => {
    expect(scopedId('run_1', '')).toBe('run_1_');
  });

  it('handles UUID-style runId', () => {
    expect(scopedId('run_550e8400-e29b-41d4-a716-446655440000', 'phase_1')).toBe(
      'run_550e8400-e29b-41d4-a716-446655440000_phase_1',
    );
  });
});

// ---------------------------------------------------------------------------
// stableGateKey
// ---------------------------------------------------------------------------
describe('stableGateKey', () => {
  it('produces a deterministic key from gate type and index', () => {
    const gate = { type: 'build' as const };
    expect(stableGateKey(gate, 0)).toBe('00:build');
    expect(stableGateKey(gate, 1)).toBe('01:build');
    expect(stableGateKey(gate, 10)).toBe('10:build');
  });

  it('zero-pads the index to two digits', () => {
    const gate = { type: 'lint' as const };
    expect(stableGateKey(gate, 0)).toMatch(/^00:/u);
    expect(stableGateKey(gate, 9)).toMatch(/^09:/u);
    expect(stableGateKey(gate, 99)).toMatch(/^99:/u);
  });

  it('includes artifactType when present', () => {
    const gate = { type: 'test' as const, artifactType: 'code-changes' as const };
    const key = stableGateKey(gate, 3);
    expect(key).toBe('03:test:artifact=code-changes');
  });

  it('includes commandRef when present', () => {
    const gate = { type: 'build' as const, commandRef: 'typecheck' as const };
    const key = stableGateKey(gate, 0);
    expect(key).toBe('00:build:commandRef=typecheck');
  });

  it('appends "skipped" when skipReason is set', () => {
    const gate = { type: 'schema' as const, skipReason: 'not applicable' };
    const key = stableGateKey(gate, 1);
    expect(key).toBe('01:schema:skipped');
  });

  it('includes all fields in order when multiple are present', () => {
    const gate = {
      type: 'e2e-pass' as const,
      artifactType: 'test-report' as const,
      commandRef: 'e2e' as const,
    };
    const key = stableGateKey(gate, 5);
    // Expected: index:type:artifact=<type>:commandRef=<ref>
    // Note: skipReason absent, so "skipped" not appended
    expect(key).toBe('05:e2e-pass:artifact=test-report:commandRef=e2e');
  });

  it('filters out falsy segments (empty strings excluded)', () => {
    // artifactType and commandRef undefined, skipReason empty — should not appear
    const gate = { type: 'human' as const };
    // No optional fields set
    const key = stableGateKey(gate, 0);
    expect(key).toBe('00:human');
  });

  it('produces the same key for equivalent gate shapes (idempotent)', () => {
    const gate = {
      type: 'security-scan' as const,
      commandRef: 'security' as const,
    };
    const a = stableGateKey(gate, 2);
    const b = stableGateKey(gate, 2);
    expect(a).toBe(b);
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
      {
        type: 'build' as const,
        gateKey: 'custom-key',
        requiresHumanApproval: false,
        maxRetries: 0,
      },
      {
        type: 'test' as const,
        requiresHumanApproval: false,
        maxRetries: 0,
      },
    ];
    const result = gatesWithStableKeys(gates, 'node_1');
    expect(result).toHaveLength(2);
    expect(result[0].gateKey).toBe('custom-key'); // preserved
    expect(result[1].gateKey).toBe('01:test'); // auto-assigned
  });

  it('throws on duplicate gate keys', () => {
    const gates = [
      {
        type: 'build' as const,
        gateKey: 'same-key',
        requiresHumanApproval: false,
        maxRetries: 0,
      },
      {
        type: 'lint' as const,
        gateKey: 'same-key',
        requiresHumanApproval: false,
        maxRetries: 0,
      },
    ];
    expect(() => gatesWithStableKeys(gates, 'my-node')).toThrow(
      /duplicate gateKey/u,
    );
  });

  it('throws on duplicate auto-generated keys (same gate at same index)', () => {
    // Two gates with same type at positions that would auto-generate the same key
    // Actually this can't happen normally because index differs — but if two
    // gates have identical auto-generated keys via content collision it could.
    // The function handles duplicates by checking uniqueness across all keys.
    const gates = [
      {
        type: 'build' as const,
        gateKey: '00:build',
        requiresHumanApproval: false,
        maxRetries: 0,
      },
      {
        type: 'build' as const,
        gateKey: '00:build',
        requiresHumanApproval: false,
        maxRetries: 0,
      },
    ];
    expect(() => gatesWithStableKeys(gates, 'dup-node')).toThrow(
      /duplicate gateKey/u,
    );
  });

  it('includes the nodeId in the duplicate error message', () => {
    const gates = [
      {
        type: 'test' as const,
        gateKey: 'dup',
        requiresHumanApproval: false,
        maxRetries: 0,
      },
      {
        type: 'lint' as const,
        gateKey: 'dup',
        requiresHumanApproval: false,
        maxRetries: 0,
      },
    ];
    expect(() => gatesWithStableKeys(gates, 'critical-node-42')).toThrow(
      /critical-node-42/u,
    );
  });

  it('returns empty array when given empty gates', () => {
    const result = gatesWithStableKeys([], 'node_1');
    expect(result).toEqual([]);
  });

  it('uses "workflow node" as default nodeId when not provided', () => {
    const gates = [
      {
        type: 'test' as const,
        gateKey: 'dup',
        requiresHumanApproval: false,
        maxRetries: 0,
      },
      {
        type: 'lint' as const,
        gateKey: 'dup',
        requiresHumanApproval: false,
        maxRetries: 0,
      },
    ];
    expect(() => gatesWithStableKeys(gates)).toThrow(/duplicate gateKey/u);
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
// makeSyntheticLease
// ---------------------------------------------------------------------------
describe('makeSyntheticLease', () => {
  const repoPath = '/home/user/projects/tekon';
  const runId = 'run_abc123';
  const node = {
    id: 'run_abc123_node_rd_1',
    role: 'rd' as const,
    phaseId: 'run_abc123_phase_1',
    inputs: [],
    outputs: [],
    gates: [],
    dependsOn: [],
  };

  it('creates a lease with id based on node.id', () => {
    const lease = makeSyntheticLease(repoPath, runId, node);
    expect(lease.id).toBe(`lease_${node.id}`);
  });

  it('assigns the runId and nodeId from arguments', () => {
    const lease = makeSyntheticLease(repoPath, runId, node);
    expect(lease.runId).toBe(runId);
    expect(lease.nodeId).toBe(node.id);
  });

  it('copies the role from the node', () => {
    const lease = makeSyntheticLease(repoPath, runId, node);
    expect(lease.role).toBe('rd');
  });

  it('sets repoPath from the argument', () => {
    const lease = makeSyntheticLease(repoPath, runId, node);
    expect(lease.repoPath).toBe(repoPath);
  });

  it('sets worktreePath equal to repoPath (in-memory lease)', () => {
    const lease = makeSyntheticLease(repoPath, runId, node);
    expect(lease.worktreePath).toBe(repoPath);
  });

  it('generates a branch name in the tekon namespace', () => {
    const lease = makeSyntheticLease(repoPath, runId, node);
    expect(lease.branchName).toBe(`tekon/${runId}/${node.id}`);
  });

  it('sets createdAt to an ISO date string', () => {
    const lease = makeSyntheticLease(repoPath, runId, node);
    expect(lease.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/u,
    );
  });

  it('works with pm and qa roles', () => {
    const pmLease = makeSyntheticLease(repoPath, runId, {
      ...node,
      id: 'node_pm',
      role: 'pm',
    });
    expect(pmLease.role).toBe('pm');
    expect(pmLease.id).toBe('lease_node_pm');

    const qaLease = makeSyntheticLease(repoPath, runId, {
      ...node,
      id: 'node_qa',
      role: 'qa',
    });
    expect(qaLease.role).toBe('qa');
    expect(qaLease.id).toBe('lease_node_qa');
  });
});

// ---------------------------------------------------------------------------
// defaultCommandPolicy
// ---------------------------------------------------------------------------
describe('defaultCommandPolicy', () => {
  it('returns a CommandPolicy with expected structure', () => {
    const policy = defaultCommandPolicy('/some/repo');
    expect(policy).toHaveProperty('allow');
    expect(policy).toHaveProperty('deny');
    expect(policy).toHaveProperty('requiresHumanApproval');
    expect(policy).toHaveProperty('cwdScope');
    expect(policy).toHaveProperty('network');
  });

  it('allows common dev tools: git, pnpm, npm, claude, codex', () => {
    const policy = defaultCommandPolicy('/repo');
    const allowedTools = policy.allow.map((entry) => entry.tool);
    expect(allowedTools).toContain('git');
    expect(allowedTools).toContain('pnpm');
    expect(allowedTools).toContain('npm');
    expect(allowedTools).toContain('claude');
    expect(allowedTools).toContain('codex');
  });

  it('has empty deny list', () => {
    const policy = defaultCommandPolicy('/repo');
    expect(policy.deny).toEqual([]);
  });

  it('has empty requiresHumanApproval list', () => {
    const policy = defaultCommandPolicy('/repo');
    expect(policy.requiresHumanApproval).toEqual([]);
  });

  it('restricts cwdScope to the given repoPath', () => {
    const repoPath = '/home/dev/my-project';
    const policy = defaultCommandPolicy(repoPath);
    expect(policy.cwdScope).toEqual([repoPath]);
  });

  it('disables network by default', () => {
    const policy = defaultCommandPolicy('/repo');
    expect(policy.network).toBe('disabled');
  });

  it('works with different repo paths', () => {
    const policy1 = defaultCommandPolicy('/a');
    expect(policy1.cwdScope).toEqual(['/a']);

    const policy2 = defaultCommandPolicy('/b/c');
    expect(policy2.cwdScope).toEqual(['/b/c']);
  });
});

// ---------------------------------------------------------------------------
// defaultBuiltInRolesDir
// ---------------------------------------------------------------------------
describe('defaultBuiltInRolesDir', () => {
  it('returns a string path', () => {
    const dir = defaultBuiltInRolesDir();
    expect(typeof dir).toBe('string');
    expect(dir.length).toBeGreaterThan(0);
  });

  it('returns a path ending with "roles"', () => {
    const dir = defaultBuiltInRolesDir();
    // The path should end with /roles or \roles
    expect(dir).toMatch(/roles$/u);
  });
});

// ---------------------------------------------------------------------------
// createWorkflowEngine basic structure
// ---------------------------------------------------------------------------
describe('createWorkflowEngine', () => {
  it('returns an object with startRun and resumeRun functions', () => {
    const engine: WorkflowEngine = createWorkflowEngine({
      repoPath: '/test',
      dataDir: '.tekon',
      repositories: {} as never,
      audit: {} as never,
      adapter: {} as never,
    });
    expect(engine).toBeDefined();
    expect(typeof engine.startRun).toBe('function');
    expect(typeof engine.resumeRun).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// review rework mechanism
// ---------------------------------------------------------------------------
describe('review rework mechanism', () => {
  describe('resolveReviewTargetNodeByHeuristic', () => {
    it('finds upstream passed node in different phase', () => {
      const nodes = [
        { id: 'run_1_rd-code', status: 'passed' },
        { id: 'run_1_qa', status: 'passed' },
        { id: 'run_1_reviewer', status: 'running' },
      ];
      const result = resolveReviewTargetNodeByHeuristic(nodes, 'run_1_reviewer');
      expect(result).toBe('run_1_qa');
    });

    it('returns null when no upstream passed node', () => {
      const nodes = [
        { id: 'run_1_blocked_rd', status: 'blocked' },
        { id: 'run_1_reviewer', status: 'running' },
      ];
      const result = resolveReviewTargetNodeByHeuristic(nodes, 'run_1_reviewer');
      expect(result).toBeNull();
    });

    it('returns null when review node is the only node', () => {
      const nodes = [
        { id: 'run_1_reviewer', status: 'running' },
      ];
      const result = resolveReviewTargetNodeByHeuristic(nodes, 'run_1_reviewer');
      expect(result).toBeNull();
    });

    it('returns null when review node is not found in list', () => {
      const nodes = [
        { id: 'run_1_rd-code', status: 'passed' },
      ];
      const result = resolveReviewTargetNodeByHeuristic(nodes, 'nonexistent');
      expect(result).toBeNull();
    });

    it('picks the last passed node when multiple upstream nodes exist', () => {
      const nodes = [
        { id: 'run_1_pm', status: 'passed' },
        { id: 'run_1_rd', status: 'passed' },
        { id: 'run_1_qa', status: 'passed' },
        { id: 'run_1_reviewer', status: 'running' },
      ];
      const result = resolveReviewTargetNodeByHeuristic(nodes, 'run_1_reviewer');
      expect(result).toBe('run_1_qa');
    });

    it('skips upstream nodes that are not passed (running, blocked, needs-revision)', () => {
      const nodes = [
        { id: 'run_1_rd', status: 'blocked' },
        { id: 'run_1_qa', status: 'needs-revision' },
        { id: 'run_1_pm', status: 'passed' },
        { id: 'run_1_another', status: 'running' },
        { id: 'run_1_reviewer', status: 'running' },
      ];
      const result = resolveReviewTargetNodeByHeuristic(nodes, 'run_1_reviewer');
      // Only 'pm' is passed among upstream nodes
      expect(result).toBe('run_1_pm');
    });
  });

  describe('isChangesRequested detection', () => {
    it('changes-requested on independent-review gate returns true', () => {
      expect(
        isChangesRequested('changes-requested', 'independent-review'),
      ).toBe(true);
    });

    it('review-not-approved on independent-review gate returns false', () => {
      expect(
        isChangesRequested('review-not-approved', 'independent-review'),
      ).toBe(false);
    });

    it('changes-requested on non-independent-review gate returns false', () => {
      expect(isChangesRequested('changes-requested', 'schema')).toBe(false);
    });

    it('changes-requested on build gate returns false', () => {
      expect(isChangesRequested('changes-requested', 'build')).toBe(false);
    });

    it('changes-requested on lint gate returns false', () => {
      expect(isChangesRequested('changes-requested', 'lint')).toBe(false);
    });

    it('changes-requested on human gate returns false', () => {
      expect(isChangesRequested('changes-requested', 'human')).toBe(false);
    });

    it('changes-requested on e2e-pass gate returns false', () => {
      expect(isChangesRequested('changes-requested', 'e2e-pass')).toBe(false);
    });

    it('undefined failureClassification returns false', () => {
      expect(
        isChangesRequested(undefined, 'independent-review'),
      ).toBe(false);
    });

    it('empty string failureClassification returns false', () => {
      expect(isChangesRequested('', 'independent-review')).toBe(false);
    });

    it('null failureClassification returns false', () => {
      expect(isChangesRequested(null, 'independent-review')).toBe(false);
    });
  });

  describe('resolveMaxReworkAttempts defaults', () => {
    it('defaults to 5 when gate.maxRetries is 0', () => {
      expect(resolveMaxReworkAttempts(0)).toBe(5);
    });

    it('defaults to 5 when gate.maxRetries is negative', () => {
      expect(resolveMaxReworkAttempts(-1)).toBe(5);
    });

    it('respects gate.maxRetries when positive', () => {
      expect(resolveMaxReworkAttempts(3)).toBe(3);
    });

    it('allows maxRetries=1 for single rework attempt', () => {
      expect(resolveMaxReworkAttempts(1)).toBe(1);
    });
  });
});
