import { describe, expect, it } from 'vitest';

import { openTekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import { createAuditLogger } from '../../src/audit/logger.js';
import {
  createLeaseService,
  nodeAllowsSourceChanges,
} from '../../src/workflow/lease-service.js';
import type { WorktreeManager } from '../../src/runtime/worktree-manager.js';
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

function makeNode(overrides?: Partial<{ id: string; role: 'rd' | 'pm' | 'qa' | 'reviewer' | 'pmo'; phaseId: string }>) {
  return {
    id: overrides?.id ?? 'run_1_node_rd',
    role: overrides?.role ?? 'rd' as const,
    phaseId: overrides?.phaseId ?? 'run_1_phase_dev',
  };
}

function makeStubWorktreeManager(overrides?: {
  ensureRunBranchError?: boolean;
  createLeaseError?: boolean;
  lease?: Partial<WorktreeLease>;
}): WorktreeManager {
  const now = new Date().toISOString();
  const defaultLease: WorktreeLease = {
    id: 'lease_test_1',
    runId: 'run_1',
    nodeId: 'run_1_node_rd',
    role: 'rd',
    repoPath: '/tmp/repo',
    worktreePath: '/tmp/repo/.worktrees/lease_test_1',
    branchName: 'tekon/run_1/lease_test_1',
    createdAt: now,
    ...overrides?.lease,
  };

  return {
    async ensureRunBranch() {
      if (overrides?.ensureRunBranchError) {
        throw new Error('git branch creation failed');
      }
      return 'tekon/run_1';
    },
    async createLease() {
      if (overrides?.createLeaseError) {
        throw new Error('worktree creation failed');
      }
      return defaultLease;
    },
    async commitLeaseChanges() {
      return true;
    },
    async inspectLeaseSourceChanges() {
      return { changedPaths: [], headChanged: false, currentHead: 'abc123' };
    },
    async listLeaseSourceChanges() {
      return [];
    },
    async getLeaseHead() {
      return 'abc123def456';
    },
    async promoteLeaseToRunBranch() {
      return 'tekon/run_1';
    },
    async releaseLease() {},
    async pruneStaleLeases() {},
    async listLeases() {
      return [];
    },
  };
}

// ---------------------------------------------------------------------------
// createExecutionLease
// ---------------------------------------------------------------------------
describe('createLeaseService — createExecutionLease', () => {
  it('creates a synthetic lease when no worktreeManager is provided', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const executionLeases = new Map<string, WorktreeLease>();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        executionLeases,
      });

      const node = makeNode();
      const lease = await service.createExecutionLease('run_1', node);

      expect(lease.id).toBe(`lease_${node.id}`);
      expect(lease.runId).toBe('run_1');
      expect(lease.nodeId).toBe(node.id);
      expect(lease.role).toBe('rd');
      expect(lease.worktreePath).toBe('/tmp/repo');
      expect(executionLeases.has(node.id)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('creates a worktree lease via worktreeManager', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      // Seed workflow instance for audit event FK
      await repositories.createProject({
        id: 'proj_1', name: 'Test', repoPath: '/tmp/repo',
        createdAt: new Date().toISOString(),
      });
      await repositories.createDemand({
        id: 'demand_1', title: 'Test', body: 'Body',
        createdAt: new Date().toISOString(),
      });
      await repositories.createWorkflowInstance({
        id: 'run_1', projectId: 'proj_1', demandId: 'demand_1', status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const executionLeases = new Map<string, WorktreeLease>();
      const worktreeManager = makeStubWorktreeManager();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        worktreeManager,
        executionLeases,
      });

      const node = makeNode();
      const lease = await service.createExecutionLease('run_1', node);

      expect(lease.id).toBe('lease_test_1');
      expect(lease.worktreePath).toBe('/tmp/repo/.worktrees/lease_test_1');
      expect(executionLeases.has(node.id)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('appends an audit event when worktreeManager creates a lease', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      // Seed a workflow instance so audit events can be stored
      await repositories.createProject({
        id: 'proj_1',
        name: 'Test',
        repoPath: '/tmp/repo',
        createdAt: new Date().toISOString(),
      });
      await repositories.createDemand({
        id: 'demand_1',
        title: 'Test',
        body: 'Body',
        createdAt: new Date().toISOString(),
      });
      await repositories.createWorkflowInstance({
        id: 'run_1',
        projectId: 'proj_1',
        demandId: 'demand_1',
        status: 'running',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      const executionLeases = new Map<string, WorktreeLease>();
      const worktreeManager = makeStubWorktreeManager();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        worktreeManager,
        executionLeases,
      });

      const node = makeNode();
      await service.createExecutionLease('run_1', node);

      const events = await repositories.listAuditEvents('run_1');
      const leaseEvents = events.filter((e) => e.type === 'worktree.lease.created');
      expect(leaseEvents).toHaveLength(1);
      expect(leaseEvents[0].payload.nodeId).toBe(node.id);
    } finally {
      db.close();
    }
  });

  it('fails gracefully when worktreeManager.ensureRunBranch throws', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const executionLeases = new Map<string, WorktreeLease>();
      const worktreeManager = makeStubWorktreeManager({ ensureRunBranchError: true });
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        worktreeManager,
        executionLeases,
      });

      const node = makeNode();
      await expect(service.createExecutionLease('run_1', node)).rejects.toThrow(
        /git branch creation failed/u,
      );
      // Lease should not be stored on failure
      expect(executionLeases.has(node.id)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('fails gracefully when worktreeManager.createLease throws', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const executionLeases = new Map<string, WorktreeLease>();
      const worktreeManager = makeStubWorktreeManager({ createLeaseError: true });
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        worktreeManager,
        executionLeases,
      });

      const node = makeNode();
      await expect(service.createExecutionLease('run_1', node)).rejects.toThrow(
        /worktree creation failed/u,
      );
      expect(executionLeases.has(node.id)).toBe(false);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// activeExecutionLease
// ---------------------------------------------------------------------------
describe('createLeaseService — activeExecutionLease', () => {
  it('returns in-memory lease when available and not released', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const executionLeases = new Map<string, WorktreeLease>();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        executionLeases,
      });

      const node = makeNode();
      const created = await service.createExecutionLease('run_1', node);

      const active = await service.activeExecutionLease('run_1', node.id);
      expect(active).toBeDefined();
      expect(active!.id).toBe(created.id);
    } finally {
      db.close();
    }
  });

  it('returns undefined when no lease exists for the node', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const executionLeases = new Map<string, WorktreeLease>();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        executionLeases,
      });

      const active = await service.activeExecutionLease('run_1', 'nonexistent');
      expect(active).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('skips in-memory lease that has been released and falls back to repository', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const executionLeases = new Map<string, WorktreeLease>();
      const releasedLease: WorktreeLease = {
        id: 'lease_released',
        runId: 'run_1',
        nodeId: 'run_1_node_rd',
        role: 'rd',
        repoPath: '/tmp/repo',
        worktreePath: '/tmp/repo',
        branchName: 'tekon/run_1/node_rd',
        createdAt: new Date().toISOString(),
        releasedAt: new Date().toISOString(),
      };
      executionLeases.set('run_1_node_rd', releasedLease);

      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        executionLeases,
      });

      // No repository lease either, so result should be undefined
      const active = await service.activeExecutionLease('run_1', 'run_1_node_rd');
      expect(active).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('caches repository lease into in-memory map for future lookups', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const executionLeases = new Map<string, WorktreeLease>();
      const now = new Date().toISOString();

      // Store a lease in the repository
      const repoLease: WorktreeLease = {
        id: 'lease_repo',
        runId: 'run_1',
        nodeId: 'run_1_node_rd',
        role: 'rd',
        repoPath: '/tmp/repo',
        worktreePath: '/tmp/repo/.worktrees/lease_repo',
        branchName: 'tekon/run_1/node_rd',
        createdAt: now,
      };
      await repositories.recordWorktreeLease(repoLease);

      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        executionLeases,
      });

      const active = await service.activeExecutionLease('run_1', 'run_1_node_rd');
      expect(active).toBeDefined();
      expect(active!.id).toBe('lease_repo');

      // Should now be cached in-memory
      expect(executionLeases.has('run_1_node_rd')).toBe(true);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// finalizeExecutionLease
// ---------------------------------------------------------------------------
describe('createLeaseService — finalizeExecutionLease', () => {
  it('does nothing when no active lease exists', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const executionLeases = new Map<string, WorktreeLease>();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        executionLeases,
      });

      // Should not throw
      await service.finalizeExecutionLease('run_1', 'nonexistent');
    } finally {
      db.close();
    }
  });

  it('does nothing when no worktreeManager is configured (synthetic lease)', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      const executionLeases = new Map<string, WorktreeLease>();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        executionLeases,
      });

      const node = makeNode();
      await service.createExecutionLease('run_1', node);

      // Should not throw even though the lease exists
      await service.finalizeExecutionLease('run_1', node.id);
    } finally {
      db.close();
    }
  });

  it('commits, promotes, and releases lease via worktreeManager', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      // Seed required data
      await repositories.createProject({
        id: 'proj_1', name: 'Test', repoPath: '/tmp/repo',
        createdAt: new Date().toISOString(),
      });
      await repositories.createDemand({
        id: 'demand_1', title: 'Test', body: 'Body',
        createdAt: new Date().toISOString(),
      });
      await repositories.createWorkflowInstance({
        id: 'run_1', projectId: 'proj_1', demandId: 'demand_1',
        status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await repositories.createNode({
        id: 'run_1_node_rd', runId: 'run_1', role: 'rd', status: 'running',
        outputs: [{ id: 'code', type: 'code-changes' }],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      let committed = false;
      let promoted = false;
      let released = false;

      const worktreeManager: WorktreeManager = {
        async ensureRunBranch() { return 'tekon/run_1'; },
        async createLease() {
          return {
            id: 'lease_final', runId: 'run_1', nodeId: 'run_1_node_rd', role: 'rd',
            repoPath: '/tmp/repo', worktreePath: '/tmp/repo/.worktrees/lease_final',
            branchName: 'tekon/run_1/lease_final', createdAt: new Date().toISOString(),
          };
        },
        async commitLeaseChanges() { committed = true; return true; },
        async inspectLeaseSourceChanges() {
          return { changedPaths: [], headChanged: false, currentHead: 'abc' };
        },
        async listLeaseSourceChanges() { return []; },
        async getLeaseHead() { return 'abc123'; },
        async promoteLeaseToRunBranch() { promoted = true; return 'tekon/run_1'; },
        async releaseLease() { released = true; },
        async pruneStaleLeases() {},
        async listLeases() { return []; },
      };

      const executionLeases = new Map<string, WorktreeLease>();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        worktreeManager,
        executionLeases,
      });

      const node = makeNode();
      await service.createExecutionLease('run_1', node);
      await service.finalizeExecutionLease('run_1', node.id);

      expect(committed).toBe(true);
      expect(promoted).toBe(true);
      expect(released).toBe(true);
    } finally {
      db.close();
    }
  });

  it('removes lease from in-memory map after finalization', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      await repositories.createProject({
        id: 'proj_1', name: 'Test', repoPath: '/tmp/repo',
        createdAt: new Date().toISOString(),
      });
      await repositories.createDemand({
        id: 'demand_1', title: 'Test', body: 'Body',
        createdAt: new Date().toISOString(),
      });
      await repositories.createWorkflowInstance({
        id: 'run_1', projectId: 'proj_1', demandId: 'demand_1',
        status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      await repositories.createNode({
        id: 'run_1_node_rd', runId: 'run_1', role: 'rd', status: 'running',
        outputs: [{ id: 'code', type: 'code-changes' }],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const worktreeManager = makeStubWorktreeManager();
      const executionLeases = new Map<string, WorktreeLease>();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        worktreeManager,
        executionLeases,
      });

      const node = makeNode();
      await service.createExecutionLease('run_1', node);
      expect(executionLeases.size).toBeGreaterThan(0);

      await service.finalizeExecutionLease('run_1', node.id);
      // All aliases for this lease should be deleted
      expect(executionLeases.has(node.id)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('throws when non-code node has source changes', async () => {
    const { db, repositories, audit } = createTestDb();
    try {
      await repositories.createProject({
        id: 'proj_1', name: 'Test', repoPath: '/tmp/repo',
        createdAt: new Date().toISOString(),
      });
      await repositories.createDemand({
        id: 'demand_1', title: 'Test', body: 'Body',
        createdAt: new Date().toISOString(),
      });
      await repositories.createWorkflowInstance({
        id: 'run_1', projectId: 'proj_1', demandId: 'demand_1',
        status: 'running',
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });
      // Node with no code-changes output (e.g., reviewer)
      await repositories.createNode({
        id: 'run_1_node_reviewer', runId: 'run_1', role: 'reviewer', status: 'running',
        outputs: [{ id: 'review-report', type: 'review-report' }],
        createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      });

      const worktreeManager: WorktreeManager = {
        async ensureRunBranch() { return 'tekon/run_1'; },
        async createLease() {
          return {
            id: 'lease_review', runId: 'run_1', nodeId: 'run_1_node_reviewer',
            role: 'reviewer', repoPath: '/tmp/repo',
            worktreePath: '/tmp/repo/.worktrees/lease_review',
            branchName: 'tekon/run_1/lease_review',
            createdAt: new Date().toISOString(),
          };
        },
        async commitLeaseChanges() { return true; },
        async inspectLeaseSourceChanges() {
          return { changedPaths: ['src/main.ts'], headChanged: false, currentHead: 'def456' };
        },
        async listLeaseSourceChanges() { return ['src/main.ts']; },
        async getLeaseHead() { return 'def456'; },
        async promoteLeaseToRunBranch() { return 'tekon/run_1'; },
        async releaseLease() {},
        async pruneStaleLeases() {},
        async listLeases() { return []; },
      };

      const executionLeases = new Map<string, WorktreeLease>();
      const service = createLeaseService({
        repoPath: '/tmp/repo',
        repositories,
        audit,
        worktreeManager,
        executionLeases,
      });

      const node = makeNode({ id: 'run_1_node_reviewer', role: 'reviewer' });
      await service.createExecutionLease('run_1', node);

      await expect(
        service.finalizeExecutionLease('run_1', node.id),
      ).rejects.toThrow(/not allowed to modify repository source files/u);
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// nodeAllowsSourceChanges
// ---------------------------------------------------------------------------
describe('nodeAllowsSourceChanges', () => {
  it('returns true when node has code-changes output', () => {
    expect(
      nodeAllowsSourceChanges({
        outputs: [{ id: 'code', type: 'code-changes' }],
      }),
    ).toBe(true);
  });

  it('returns false when node has no code-changes output', () => {
    expect(
      nodeAllowsSourceChanges({
        outputs: [{ id: 'review', type: 'review-report' }],
      }),
    ).toBe(false);
  });

  it('returns false when node has empty outputs', () => {
    expect(nodeAllowsSourceChanges({ outputs: [] })).toBe(false);
  });

  it('returns false for null node', () => {
    expect(nodeAllowsSourceChanges(null)).toBe(false);
  });
});
