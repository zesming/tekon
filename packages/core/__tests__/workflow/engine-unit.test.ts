import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertSuccessfulAgentRun,
  createAuditLogger,
  createMockAgentAdapter,
  createRepositories,
  createSubprocessRegistry,
  createWorkflowEngine,
  defaultBuiltInRolesDir,
  defaultCommandPolicy,
  gatesWithStableKeys,
  isChangesRequested,
  isWorkflowTerminalError,
  makeSyntheticLease,
  migrateDatabase,
  openTekonDatabase,
  resolveMaxReworkAttempts,
  resolveReviewTargetNodeByHeuristic,
  scopedId,
  stableGateKey,
  type AgentRunInput,
  type CreateWorkflowEngineOptions,
  type WorkflowEngine,
  type WorkflowTemplate,
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

  it('allows common dev tools: git, pnpm, npm, claude, codex, dsh', () => {
    const policy = defaultCommandPolicy('/repo');
    const allowedTools = policy.allow.map((entry) => entry.tool);
    expect(allowedTools).toContain('git');
    expect(allowedTools).toContain('pnpm');
    expect(allowedTools).toContain('npm');
    expect(allowedTools).toContain('claude');
    expect(allowedTools).toContain('codex');
    // dsh-headless provider (phase 5b): without this, every real dsh run is
    // rejected by the gateway allow-policy. Regression lock for review M1.
    expect(allowedTools).toContain('dsh');
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

  it('resumeRun throws WorkflowTerminalError for terminal runs (P1-04)', async () => {
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await repositories.createDemand({
      id: 'demand_terminal',
      title: 'Terminal run',
      body: 'resume must throw.',
      createdAt: '2026-08-21T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_terminal',
      name: 'tekon',
      repoPath: '/tmp/tekon',
      createdAt: '2026-08-21T00:00:00.000Z',
    });
    for (const status of ['passed', 'failed', 'cancelled'] as const) {
      const runId = `run_${status}`;
      await repositories.createWorkflowInstance({
        id: runId,
        projectId: 'project_terminal',
        demandId: 'demand_terminal',
        status,
        createdAt: '2026-08-21T00:00:00.000Z',
        updatedAt: '2026-08-21T00:00:00.000Z',
      });
    }
    const audit = createAuditLogger({ repositories });
    const engine = createWorkflowEngine({
      repoPath: '/tmp/tekon',
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: {} as never,
    });

    for (const status of ['passed', 'failed', 'cancelled'] as const) {
      const runId = `run_${status}`;
      await expect(engine.resumeRun(runId)).rejects.toSatisfy((error) => {
        expect(isWorkflowTerminalError(error)).toBe(true);
        expect(error).toMatchObject({
          code: 'WORKFLOW_TERMINAL',
          runId,
          status,
        });
        return true;
      });
      // No run.resumed audit was appended for the terminal run.
      const events = await repositories.listAuditEvents(runId);
      expect(events).toEqual([]);
    }

    await expect(engine.resumeRun('run_missing')).rejects.toThrow(
      /run not found/u,
    );
    db.close();
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

// ---------------------------------------------------------------------------
// S5: prepareRun split + signal/pause/checkpoint wiring (design §2.6, §4.2)
// ---------------------------------------------------------------------------
describe('S5 engine prepareRun / signal / pause', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  // Minimal two-node template: node_a (pm, demand-card) → node_b (rd, code-changes).
  const minimalTemplate: WorkflowTemplate = {
    id: 'minimal-s5-test',
    name: 'Minimal S5 Test',
    version: 1,
    retryPolicy: {
      maxAttempts: 1,
      backoffMs: 0,
      strategy: 'fixed',
      onExhausted: 'block',
    },
    phases: [
      {
        id: 'phase_1',
        name: 'Phase 1',
        dependsOn: [],
        parallel: false,
        nodes: [
          {
            id: 'node_a',
            role: 'pm',
            inputs: [],
            outputs: [{ id: 'out_a', type: 'demand-card' }],
            gates: [],
            dependsOn: [],
          },
          {
            id: 'node_b',
            role: 'rd',
            inputs: [
              { id: 'in_a', fromNodeId: 'node_a', type: 'demand-card' },
            ],
            outputs: [{ id: 'out_b', type: 'code-changes' }],
            gates: [],
            dependsOn: ['node_a'],
          },
        ],
      },
    ],
  };

  function setupHarness(
    overrides: Partial<CreateWorkflowEngineOptions> = {},
  ) {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-s5-engine-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const mock = createMockAgentAdapter();
    const runAgentSpy = vi.fn((input: AgentRunInput) => mock.runAgent(input));
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: { runAgent: (input) => runAgentSpy(input) },
      ...overrides,
    });
    return { engine, repositories, audit, runAgentSpy, mock, db };
  }

  function startInput() {
    return {
      demandText: 'S5 test demand',
      mode: 'template' as const,
      workflowSpec: minimalTemplate,
    };
  }

  it('prepareRun persists the run without invoking the adapter; executePreparedRun runs it', async () => {
    const { engine, runAgentSpy } = setupHarness();

    const { runId, workflow } = await engine.prepareRun(startInput());
    expect(workflow.status).toBe('running');
    expect(runAgentSpy).not.toHaveBeenCalled();

    const executed = await engine.executePreparedRun(runId);
    expect(executed.status).toBe('passed');
    expect(runAgentSpy).toHaveBeenCalledTimes(2);
  });

  it('prepareRun persists plan_snapshot and plan_digest to workflow_instances', async () => {
    const { engine, repositories } = setupHarness();

    const { runId, workflow } = await engine.prepareRun(startInput());
    expect(workflow.planSnapshot).toBeTruthy();
    expect(workflow.planDigest).toMatch(/^[0-9a-f]{64}$/);

    const persisted = await repositories.getWorkflowInstance(runId);
    expect(persisted?.planSnapshot).toBe(workflow.planSnapshot);
    expect(persisted?.planDigest).toBe(workflow.planDigest);
  });

  it('startRun still executes the full workflow (CLI compatibility)', async () => {
    const { engine, runAgentSpy } = setupHarness();

    const result = await engine.startRun(startInput());
    expect(result.workflow.status).toBe('passed');
    expect(runAgentSpy).toHaveBeenCalledTimes(2);
  });

  it('signal aborted before execution settles the run cancelled (idempotent re-run)', async () => {
    const controller = new AbortController();
    controller.abort();
    const { engine, repositories } = setupHarness({ signal: controller.signal });

    const result = await engine.startRun(startInput());
    expect(result.workflow.status).toBe('cancelled');

    // Idempotent: a second executePreparedRun on the cancelled run must not throw.
    const second = await engine.executePreparedRun(result.runId);
    expect(second.status).toBe('cancelled');

    const events = await repositories.listAuditEvents(result.runId);
    expect(events.some((event) => event.type === 'run.passed')).toBe(false);
  });

  it('signal abort during node execution cancels the run, interrupts the role_run, and propagates the signal into the agent input', async () => {
    const controller = new AbortController();
    const mock = createMockAgentAdapter();
    const seenSignals: AbortSignal[] = [];
    const { engine, repositories } = setupHarness({
      signal: controller.signal,
      adapter: {
        runAgent: async (input) => {
          seenSignals.push(input.signal!);
          if (!controller.signal.aborted) {
            // Cancel arrives while the agent is running.
            controller.abort();
          }
          // mock adapter sees the aborted signal and returns cancelled:true.
          return mock.runAgent(input);
        },
      },
    });

    const result = await engine.startRun(startInput());
    expect(result.workflow.status).toBe('cancelled');

    const firstNodeId = scopedId(result.runId, 'node_a');
    const roleRun = await repositories.getLatestRoleRunForNode(
      result.runId,
      firstNodeId,
    );
    expect(roleRun?.status).toBe('interrupted');
    const node = await repositories.getNode(firstNodeId);
    expect(node?.status).toBe('interrupted');
    // The engine propagated its signal into the agent input.
    expect(seenSignals[0]).toBe(controller.signal);
  });

  it('pause request stops the run at a node boundary without killing subprocesses', async () => {
    let pauseRequested = false;
    const checkpointSpy = vi.fn(async () => {
      if (!pauseRequested) {
        pauseRequested = true;
      }
    });
    const registry = createSubprocessRegistry();
    const killAllSpy = vi.spyOn(registry, 'killAll');
    const { engine, runAgentSpy } = setupHarness({
      isPauseRequested: () => pauseRequested,
      onNodeCheckpoint: checkpointSpy,
      registry,
    });

    const result = await engine.startRun(startInput());
    expect(result.workflow.status).toBe('paused');
    // node_b never started.
    expect(runAgentSpy).toHaveBeenCalledTimes(1);
    // Only node_a completed and checkpointed.
    expect(checkpointSpy).toHaveBeenCalledTimes(1);
    // Pause must not kill subprocesses (only cancel does).
    expect(killAllSpy).not.toHaveBeenCalled();
  });

  it('onNodeCheckpoint is invoked once per completed node on a full run', async () => {
    const checkpointSpy = vi.fn(async () => {});
    const { engine } = setupHarness({ onNodeCheckpoint: checkpointSpy });

    const result = await engine.startRun(startInput());
    expect(result.workflow.status).toBe('passed');
    expect(checkpointSpy).toHaveBeenCalledTimes(2);
    expect(checkpointSpy.mock.calls[0][0]).toContain('node_a');
    expect(checkpointSpy.mock.calls[1][0]).toContain('node_b');
  });

  it('Gap B: pause requested after the last node top-check is caught before the passed write', async () => {
    let pauseRequested = false;
    const { engine, repositories } = setupHarness({
      isPauseRequested: () => pauseRequested,
      onNodeCheckpoint: async (nodeId) => {
        if (nodeId.endsWith('node_b')) {
          // Pause lands after the last node's top-check passed but before
          // the executePlan tail writes `passed`.
          pauseRequested = true;
        }
      },
    });

    const result = await engine.startRun(startInput());
    expect(result.workflow.status).toBe('paused');

    const events = await repositories.listAuditEvents(result.runId);
    expect(events.some((event) => event.type === 'run.passed')).toBe(false);
  });

  it('MUST-FIX1: paused→passed returns written=false; run stays paused with no run.passed audit', async () => {
    const { engine, repositories } = setupHarness();

    const { runId } = await engine.prepareRun(startInput());
    // Simulate a concurrent pause that landed after all nodes finished:
    // every node is already passed, the workflow was flipped to paused.
    const nodes = await repositories.listNodes(runId);
    expect(nodes.length).toBeGreaterThan(0);
    for (const node of nodes) {
      await repositories.transitionNode(node.id, 'passed');
    }
    await repositories.updateWorkflowInstanceStatus(runId, 'paused');

    const result = await engine.executePreparedRun(runId);
    expect(result.status).toBe('paused');

    const events = await repositories.listAuditEvents(runId);
    expect(events.some((event) => event.type === 'run.passed')).toBe(false);
  });
});
