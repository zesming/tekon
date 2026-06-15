import { describe, expect, it } from 'vitest';

import { openTekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import { createAuditLogger } from '../../src/audit/logger.js';
import {
  createWorkflowHelpers,
  assertSuccessfulAgentRun,
  isQaValidationNode,
  requiredArtifactTypesForNode,
} from '../../src/workflow/helpers.js';
import type { AgentRunResult } from '../../src/runtime/agent-adapter.js';
import type { WorktreeLease } from '../../src/types/config.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  return { db, repositories, audit };
}

const NOW = '2026-06-15T10:00:00.000Z';

async function seedWorkflow(
  repositories: ReturnType<typeof createRepositories>,
  runId = 'run_1',
) {
  await repositories.createProject({
    id: 'proj_1',
    name: 'Test Project',
    repoPath: '/tmp/repo',
    createdAt: NOW,
  });
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Test Demand',
    body: 'Demand body',
    createdAt: NOW,
  });
  await repositories.createWorkflowInstance({
    id: runId,
    projectId: 'proj_1',
    demandId: 'demand_1',
    status: 'running',
    createdAt: NOW,
    updatedAt: NOW,
  });
}

// ---------------------------------------------------------------------------
// assertSuccessfulAgentRun (pure helper)
// ---------------------------------------------------------------------------
describe('assertSuccessfulAgentRun', () => {
  it('passes on success (exitCode 0, not timed out)', () => {
    const result: AgentRunResult = {
      provider: 'claude-code',
      exitCode: 0,
      durationMs: 5000,
      outputFiles: ['out.json'],
      timedOut: false,
    };
    expect(() => assertSuccessfulAgentRun(result)).not.toThrow();
  });

  it('throws when the agent timed out', () => {
    const result: AgentRunResult = {
      provider: 'codex',
      exitCode: 0,
      durationMs: 60000,
      outputFiles: [],
      timedOut: true,
    };
    expect(() => assertSuccessfulAgentRun(result)).toThrow(/agent timed out/u);
  });

  it('throws on non-zero exit code', () => {
    const result: AgentRunResult = {
      provider: 'custom',
      exitCode: 1,
      durationMs: 3000,
      outputFiles: [],
      timedOut: false,
    };
    expect(() => assertSuccessfulAgentRun(result)).toThrow(/agent failed/u);
  });

  it('throws on null exit code (treated as non-zero)', () => {
    const result: AgentRunResult = {
      provider: 'claude-code',
      exitCode: null,
      durationMs: 1000,
      outputFiles: [],
      timedOut: false,
    };
    expect(() => assertSuccessfulAgentRun(result)).toThrow(/agent failed/u);
  });

  it('includes provider name in timeout error', () => {
    const result: AgentRunResult = {
      provider: 'codex',
      exitCode: 0,
      durationMs: 60000,
      outputFiles: [],
      timedOut: true,
    };
    expect(() => assertSuccessfulAgentRun(result)).toThrow(/provider=codex/u);
  });

  it('includes provider name and exit code in failure error', () => {
    const result: AgentRunResult = {
      provider: 'mock',
      exitCode: 2,
      durationMs: 100,
      outputFiles: [],
      timedOut: false,
    };
    expect(() => assertSuccessfulAgentRun(result)).toThrow(/provider=mock/);
    expect(() => assertSuccessfulAgentRun(result)).toThrow(/exitCode=2/);
  });
});

// ---------------------------------------------------------------------------
// isQaValidationNode (pure helper)
// ---------------------------------------------------------------------------
describe('isQaValidationNode', () => {
  it('returns true for qa node with test-report output', () => {
    expect(
      isQaValidationNode({
        role: 'qa',
        outputs: [{ id: 'report', type: 'test-report' }],
      }),
    ).toBe(true);
  });

  it('returns true for qa node with ac-evidence output', () => {
    expect(
      isQaValidationNode({
        role: 'qa',
        outputs: [{ id: 'evidence', type: 'ac-evidence' }],
      }),
    ).toBe(true);
  });

  it('returns false for qa node without test-report or ac-evidence', () => {
    expect(
      isQaValidationNode({
        role: 'qa',
        outputs: [{ id: 'signoff', type: 'qa-release-signoff' }],
      }),
    ).toBe(false);
  });

  it('returns false for non-qa role even with test-report', () => {
    expect(
      isQaValidationNode({
        role: 'rd',
        outputs: [{ id: 'report', type: 'test-report' }],
      }),
    ).toBe(false);
  });

  it('returns false for qa node with empty outputs', () => {
    expect(isQaValidationNode({ role: 'qa', outputs: [] })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// requiredArtifactTypesForNode (pure helper)
// ---------------------------------------------------------------------------
describe('requiredArtifactTypesForNode', () => {
  it('collects artifact types from outputs', () => {
    const result = requiredArtifactTypesForNode({
      outputs: [
        { id: 'prd', type: 'prd' },
        { id: 'tech-design', type: 'tech-design' },
      ],
    });
    expect(result).toContain('prd');
    expect(result).toContain('tech-design');
  });

  it('collects artifact types from schema gates', () => {
    const result = requiredArtifactTypesForNode({
      gates: [
        {
          type: 'schema',
          artifactType: 'code-changes',
          requiresHumanApproval: false,
          maxRetries: 0,
          retryPolicy: { maxAttempts: 1, maxRetries: 0, backoffMs: 0, strategy: 'fixed', onExhausted: 'block' },
          onExhausted: 'block',
        },
      ],
    });
    expect(result).toContain('code-changes');
  });

  it('deduplicates artifact types', () => {
    const result = requiredArtifactTypesForNode({
      outputs: [{ id: 'prd', type: 'prd' }],
      gates: [
        {
          type: 'schema',
          artifactType: 'prd',
          requiresHumanApproval: false,
          maxRetries: 0,
          retryPolicy: { maxAttempts: 1, maxRetries: 0, backoffMs: 0, strategy: 'fixed', onExhausted: 'block' },
          onExhausted: 'block',
        },
      ],
    });
    const prdCount = result.filter((t) => t === 'prd').length;
    expect(prdCount).toBe(1);
  });

  it('returns empty array when no outputs or gates', () => {
    expect(requiredArtifactTypesForNode({})).toEqual([]);
    expect(requiredArtifactTypesForNode({ outputs: [], gates: [] })).toEqual([]);
  });

  it('ignores non-schema gates', () => {
    const result = requiredArtifactTypesForNode({
      gates: [
        {
          type: 'build',
          requiresHumanApproval: false,
          maxRetries: 0,
          retryPolicy: { maxAttempts: 1, maxRetries: 0, backoffMs: 0, strategy: 'fixed', onExhausted: 'block' },
          onExhausted: 'block',
        },
      ],
    });
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// mustGetWorkflow (via createWorkflowHelpers)
// ---------------------------------------------------------------------------
describe('mustGetWorkflow', () => {
  it('returns the workflow instance when it exists', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      await seedWorkflow(repositories, 'run_found');

      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      const wf = await helpers.mustGetWorkflow('run_found');
      expect(wf.id).toBe('run_found');
      expect(wf.projectId).toBe('proj_1');
      expect(wf.status).toBe('running');
    } finally {
      db.close();
    }
  });

  it('throws when workflow does not exist', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      await expect(helpers.mustGetWorkflow('nonexistent')).rejects.toThrow(
        /run not found/u,
      );
    } finally {
      db.close();
    }
  });

  it('includes the runId in the error message', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      await expect(helpers.mustGetWorkflow('run_missing_42')).rejects.toThrow(
        /run_missing_42/u,
      );
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// mustGetDemand (via createWorkflowHelpers)
// ---------------------------------------------------------------------------
describe('mustGetDemand', () => {
  it('returns the demand when it exists', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      await repositories.createDemand({
        id: 'demand_found',
        title: 'My Demand',
        body: 'Demand body text',
        createdAt: NOW,
      });

      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      const demand = await helpers.mustGetDemand('demand_found');
      expect(demand.id).toBe('demand_found');
      expect(demand.title).toBe('My Demand');
      expect(demand.body).toBe('Demand body text');
    } finally {
      db.close();
    }
  });

  it('throws when demand does not exist', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      await expect(helpers.mustGetDemand('nonexistent')).rejects.toThrow(
        /demand not found/u,
      );
    } finally {
      db.close();
    }
  });

  it('includes the demandId in the error message', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      await expect(helpers.mustGetDemand('demand_xyz')).rejects.toThrow(
        /demand_xyz/u,
      );
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// deliveryRefForNode (tested indirectly via hasCompletedAgentRun)
// ---------------------------------------------------------------------------
describe('hasCompletedAgentRun', () => {
  it('returns true when latest role run is passed with completedAt', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      await seedWorkflow(repositories);
      await repositories.createNode({
        id: 'node_1', runId: 'run_1', role: 'rd', status: 'passed',
        createdAt: NOW, updatedAt: NOW,
      });
      await repositories.createRoleRun({
        id: 'rr_1', runId: 'run_1', nodeId: 'node_1', role: 'rd',
        status: 'passed', startedAt: NOW, completedAt: NOW,
      });

      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      const result = await helpers.hasCompletedAgentRun('run_1', 'node_1');
      expect(result).toBe(true);
    } finally {
      db.close();
    }
  });

  it('returns false when no role run exists', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      await seedWorkflow(repositories);

      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      const result = await helpers.hasCompletedAgentRun('run_1', 'node_1');
      expect(result).toBe(false);
    } finally {
      db.close();
    }
  });

  it('returns false when role run is running (not completed)', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      await seedWorkflow(repositories);
      await repositories.createNode({
        id: 'node_1', runId: 'run_1', role: 'rd', status: 'running',
        createdAt: NOW, updatedAt: NOW,
      });
      await repositories.createRoleRun({
        id: 'rr_1', runId: 'run_1', nodeId: 'node_1', role: 'rd',
        status: 'running', startedAt: NOW,
      });

      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      const result = await helpers.hasCompletedAgentRun('run_1', 'node_1');
      expect(result).toBe(false);
    } finally {
      db.close();
    }
  });

  it('returns false when role run passed but has no completedAt', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      await seedWorkflow(repositories);
      await repositories.createNode({
        id: 'node_1', runId: 'run_1', role: 'rd', status: 'passed',
        createdAt: NOW, updatedAt: NOW,
      });
      await repositories.createRoleRun({
        id: 'rr_1', runId: 'run_1', nodeId: 'node_1', role: 'rd',
        status: 'passed', startedAt: NOW,
        // No completedAt
      });

      const helpers = createWorkflowHelpers({
        repoPath: '/tmp/repo',
        dataDir: '.tekon',
        repositories,
        audit,
        promptBuilder: { appendArtifactProtocol: (p) => p },
        leaseService: {
          async createExecutionLease() { return {} as WorktreeLease; },
          async activeExecutionLease() { return undefined; },
          async finalizeExecutionLease() {},
        },
        artifactStore: {} as never,
      });

      const result = await helpers.hasCompletedAgentRun('run_1', 'node_1');
      expect(result).toBe(false);
    } finally {
      db.close();
    }
  });
});
