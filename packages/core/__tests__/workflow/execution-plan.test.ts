import { afterEach, describe, expect, it } from 'vitest';

import { openTekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import {
  templateToPlan,
  persistPlan,
  planFromRepository,
} from '../../src/workflow/execution-plan.js';
import type {
  WorkflowTemplate,
  WorkflowTemplatePhase,
  WorkflowTemplateNode,
} from '../../src/workflow/template.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeRetryPolicy() {
  return {
    maxAttempts: 1,
    maxRetries: 0,
    backoffMs: 0,
    strategy: 'fixed' as const,
    onExhausted: 'block' as const,
  };
}

function makeGate(type: string, index: number) {
  return {
    type: type as 'build' | 'lint' | 'test' | 'schema',
    requiresHumanApproval: false,
    maxRetries: 0,
    retryPolicy: makeRetryPolicy(),
    onExhausted: 'block' as const,
  };
}

function makeTemplate(overrides?: Partial<WorkflowTemplate>): WorkflowTemplate {
  const rdNode: WorkflowTemplateNode = {
    id: 'rd-code',
    role: 'rd',
    inputs: [],
    outputs: [{ id: 'code-changes', type: 'code-changes' }],
    gates: [
      makeGate('build', 0),
      makeGate('lint', 1),
    ],
    dependsOn: [],
  };

  const reviewerNode: WorkflowTemplateNode = {
    id: 'reviewer',
    role: 'reviewer',
    inputs: [
      { id: 'code-changes', type: 'code-changes', fromNodeId: 'rd-code' },
    ],
    outputs: [{ id: 'review-report', type: 'review-report' }],
    gates: [],
    dependsOn: ['rd-code'],
  };

  const phase1: WorkflowTemplatePhase = {
    id: 'phase-dev',
    name: 'Development',
    dependsOn: [],
    parallel: false,
    nodes: [rdNode],
  };

  const phase2: WorkflowTemplatePhase = {
    id: 'phase-review',
    name: 'Review',
    dependsOn: ['phase-dev'],
    parallel: false,
    nodes: [reviewerNode],
  };

  return {
    id: 'test-workflow',
    name: 'Test Workflow',
    version: 1,
    retryPolicy: makeRetryPolicy(),
    phases: [phase1, phase2],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory database helpers
// ---------------------------------------------------------------------------

function createTestDb() {
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const repositories = createRepositories(db);
  return { db, repositories };
}

async function seedRun(
  repositories: ReturnType<typeof createRepositories>,
  runId: string,
) {
  const now = new Date().toISOString();
  await repositories.createProject({
    id: 'proj_1', name: 'Test', repoPath: '/tmp/repo', createdAt: now,
  });
  await repositories.createDemand({
    id: 'demand_1', title: 'Test', body: 'Body', createdAt: now,
  });
  await repositories.createWorkflowInstance({
    id: runId, projectId: 'proj_1', demandId: 'demand_1', status: 'running',
    createdAt: now, updatedAt: now,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('templateToPlan', () => {
  it('converts a template to an execution plan with correct phase structure', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_1');

    expect(plan.phases).toHaveLength(2);
    expect(plan.phases[0].name).toBe('Development');
    expect(plan.phases[1].name).toBe('Review');
  });

  it('scopes phase IDs with the runId prefix', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_42');

    expect(plan.phases[0].id).toBe('run_42_phase-dev');
    expect(plan.phases[1].id).toBe('run_42_phase-review');
  });

  it('scopes node IDs with the runId prefix', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_1');

    const devNodes = plan.phases[0].nodes;
    const reviewNodes = plan.phases[1].nodes;

    expect(devNodes).toHaveLength(1);
    expect(devNodes[0].id).toBe('run_1_rd-code');
    expect(reviewNodes).toHaveLength(1);
    expect(reviewNodes[0].id).toBe('run_1_reviewer');
  });

  it('assigns phaseId to each node', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_1');

    expect(plan.phases[0].nodes[0].phaseId).toBe('run_1_phase-dev');
    expect(plan.phases[1].nodes[0].phaseId).toBe('run_1_phase-review');
  });

  it('resolves inter-node input references to scoped IDs', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_1');

    const reviewerNode = plan.phases[1].nodes[0];
    expect(reviewerNode.inputs).toHaveLength(1);
    expect(reviewerNode.inputs[0].fromNodeId).toBe('run_1_rd-code');
  });

  it('resolves dependsOn to scoped IDs', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_1');

    const reviewerNode = plan.phases[1].nodes[0];
    expect(reviewerNode.dependsOn).toEqual(['run_1_rd-code']);
  });

  it('preserves node role', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_1');

    expect(plan.phases[0].nodes[0].role).toBe('rd');
    expect(plan.phases[1].nodes[0].role).toBe('reviewer');
  });

  it('assigns stable gate keys to node gates', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_1');

    const rdNode = plan.phases[0].nodes[0];
    expect(rdNode.gates).toHaveLength(2);
    expect(rdNode.gates[0].gateKey).toBe('00:build');
    expect(rdNode.gates[1].gateKey).toBe('01:lint');
  });

  it('generates unique node IDs across phases with same runId', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_1');

    const allNodeIds = plan.phases.flatMap((p) => p.nodes.map((n) => n.id));
    const uniqueIds = new Set(allNodeIds);
    expect(uniqueIds.size).toBe(allNodeIds.length);
  });

  it('produces different plans for different runIds', () => {
    const template = makeTemplate();
    const planA = templateToPlan(template, 'run_a');
    const planB = templateToPlan(template, 'run_b');

    expect(planA.phases[0].id).not.toBe(planB.phases[0].id);
    expect(planA.phases[0].nodes[0].id).not.toBe(planB.phases[0].nodes[0].id);
  });

  it('preserves node outputs unchanged', () => {
    const template = makeTemplate();
    const plan = templateToPlan(template, 'run_1');

    const rdNode = plan.phases[0].nodes[0];
    expect(rdNode.outputs).toEqual([{ id: 'code-changes', type: 'code-changes' }]);
  });
});

// ---------------------------------------------------------------------------
// persistPlan
// ---------------------------------------------------------------------------
describe('persistPlan', () => {
  it('writes all phases and nodes to repositories', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_persist');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_persist');

      await persistPlan('run_persist', plan, repositories);

      const phases = await repositories.listPhases('run_persist');
      expect(phases).toHaveLength(2);
      expect(phases[0].name).toBe('Development');
      expect(phases[1].name).toBe('Review');

      const nodes = await repositories.listNodes('run_persist');
      expect(nodes).toHaveLength(2);
    } finally {
      db.close();
    }
  });

  it('sets phase order correctly', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_order');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_order');

      await persistPlan('run_order', plan, repositories);

      const phases = await repositories.listPhases('run_order');
      expect(phases[0].order).toBe(0);
      expect(phases[1].order).toBe(1);
    } finally {
      db.close();
    }
  });

  it('sets initial status to pending for all phases and nodes', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_status');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_status');

      await persistPlan('run_status', plan, repositories);

      const phases = await repositories.listPhases('run_status');
      for (const phase of phases) {
        expect(phase.status).toBe('pending');
      }

      const nodes = await repositories.listNodes('run_status');
      for (const node of nodes) {
        expect(node.status).toBe('pending');
      }
    } finally {
      db.close();
    }
  });

  it('persists node dependencies', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_deps');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_deps');

      await persistPlan('run_deps', plan, repositories);

      const nodes = await repositories.listNodes('run_deps');
      const reviewerNode = nodes.find((n) => n.role === 'reviewer');
      expect(reviewerNode).toBeDefined();
      expect(reviewerNode!.dependencies).toEqual(['run_deps_rd-code']);
    } finally {
      db.close();
    }
  });

  it('persists node inputs and outputs', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_io');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_io');

      await persistPlan('run_io', plan, repositories);

      const nodes = await repositories.listNodes('run_io');
      const rdNode = nodes.find((n) => n.role === 'rd');
      expect(rdNode).toBeDefined();
      expect(rdNode!.outputs).toHaveLength(1);
      expect(rdNode!.outputs[0].type).toBe('code-changes');

      const reviewerNode = nodes.find((n) => n.role === 'reviewer');
      expect(reviewerNode).toBeDefined();
      expect(reviewerNode!.inputs).toHaveLength(1);
      expect(reviewerNode!.inputs[0].fromNodeId).toBe('run_io_rd-code');
    } finally {
      db.close();
    }
  });
});

// ---------------------------------------------------------------------------
// planFromRepository
// ---------------------------------------------------------------------------
describe('planFromRepository', () => {
  it('reconstructs plan from persisted data', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_recon');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_recon');
      await persistPlan('run_recon', plan, repositories);

      const reconstructed = await planFromRepository('run_recon', repositories);

      expect(reconstructed.phases).toHaveLength(2);
      expect(reconstructed.phases[0].id).toBe('run_recon_phase-dev');
      expect(reconstructed.phases[1].id).toBe('run_recon_phase-review');
    } finally {
      db.close();
    }
  });

  it('preserves phase order', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_porder');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_porder');
      await persistPlan('run_porder', plan, repositories);

      const reconstructed = await planFromRepository('run_porder', repositories);

      expect(reconstructed.phases[0].name).toBe('Development');
      expect(reconstructed.phases[1].name).toBe('Review');
    } finally {
      db.close();
    }
  });

  it('preserves node data within phases', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_ndata');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_ndata');
      await persistPlan('run_ndata', plan, repositories);

      const reconstructed = await planFromRepository('run_ndata', repositories);

      const devNodes = reconstructed.phases[0].nodes;
      expect(devNodes).toHaveLength(1);
      expect(devNodes[0].id).toBe('run_ndata_rd-code');
      expect(devNodes[0].role).toBe('rd');

      const reviewNodes = reconstructed.phases[1].nodes;
      expect(reviewNodes).toHaveLength(1);
      expect(reviewNodes[0].id).toBe('run_ndata_reviewer');
      expect(reviewNodes[0].role).toBe('reviewer');
    } finally {
      db.close();
    }
  });

  it('preserves node dependencies after round-trip', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_rtdeps');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_rtdeps');
      await persistPlan('run_rtdeps', plan, repositories);

      const reconstructed = await planFromRepository('run_rtdeps', repositories);

      const reviewerNode = reconstructed.phases[1].nodes[0];
      expect(reviewerNode.dependsOn).toEqual(['run_rtdeps_rd-code']);
    } finally {
      db.close();
    }
  });

  it('preserves node inputs after round-trip', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_rtio');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_rtio');
      await persistPlan('run_rtio', plan, repositories);

      const reconstructed = await planFromRepository('run_rtio', repositories);

      const reviewerNode = reconstructed.phases[1].nodes[0];
      expect(reviewerNode.inputs).toHaveLength(1);
      expect(reviewerNode.inputs[0].fromNodeId).toBe('run_rtio_rd-code');
      expect(reviewerNode.inputs[0].type).toBe('code-changes');
    } finally {
      db.close();
    }
  });

  it('assigns gate keys to reconstructed nodes', async () => {
    const { db, repositories } = createTestDb();
    try {
      await seedRun(repositories, 'run_gk');
      const template = makeTemplate();
      const plan = templateToPlan(template, 'run_gk');
      await persistPlan('run_gk', plan, repositories);

      const reconstructed = await planFromRepository('run_gk', repositories);

      const rdNode = reconstructed.phases[0].nodes[0];
      expect(rdNode.gates.length).toBeGreaterThanOrEqual(2);
      for (const gate of rdNode.gates) {
        expect(gate.gateKey).toBeTruthy();
      }
    } finally {
      db.close();
    }
  });

  it('returns empty phases when no data exists for runId', async () => {
    const { db, repositories } = createTestDb();
    try {
      const reconstructed = await planFromRepository('nonexistent_run', repositories);
      expect(reconstructed.phases).toEqual([]);
    } finally {
      db.close();
    }
  });
});
