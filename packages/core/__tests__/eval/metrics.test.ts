import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createAuditLogger,
  createRepositories,
  extractRunMetrics,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

describe('eval metrics', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('extracts run metrics from repositories, artifacts, gates, humans, audit, and leases', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-metrics-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedRun(repoPath, repositories, audit);

    const metrics = await extractRunMetrics({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(metrics).toMatchObject({
      runId: 'run_1',
      workflowStatus: 'passed',
      timeToLocalPackageMs: 10_000,
      timeToPrMs: 12_000,
      gatePassRate: 0.75,
      retryCount: 2,
      humanInterventions: {
        total: 1,
        approved: 1,
        pending: 0,
        rejected: 0,
      },
      artifactIntegrity: {
        total: 2,
        existing: 2,
        sha256Matched: 2,
        missing: [],
        mismatched: [],
      },
      audit: {
        valid: true,
        eventCount: 2,
      },
      automationRatio: 0.75,
      highRiskActionCount: 2,
      worktreeLeases: {
        total: 1,
        open: 0,
      },
    });
    expect(metrics.prUrl).toBe('https://github.example/tekon/pull/1');
    expect(metrics.gateByType.build).toEqual({
      passed: 1,
      failed: 1,
      blocked: 0,
      skipped: 0,
    });
    expect(metrics.gateByType.human).toEqual({
      passed: 1,
      failed: 0,
      blocked: 0,
      skipped: 0,
    });

    db.close();
  });
});

async function seedRun(
  repoPath: string,
  repositories: ReturnType<typeof createRepositories>,
  audit: ReturnType<typeof createAuditLogger>,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Refund feature',
    body: 'Add refund support.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath,
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'passed',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:10.000Z',
  });
  await repositories.createPhase({
    id: 'phase_1',
    runId: 'run_1',
    name: 'Implementation',
    status: 'passed',
    order: 0,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:10.000Z',
  });
  await repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    phaseId: 'phase_1',
    role: 'rd',
    status: 'passed',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-05T00:00:01.000Z',
    updatedAt: '2026-06-05T00:00:09.000Z',
  });
  const store = createArtifactStore({ repoPath, repositories });
  await store.writeArtifact({
    runId: 'run_1',
    nodeId: 'node_1',
    type: 'delivery-package',
    content: '# Delivery\n',
  });
  await store.writeArtifact({
    runId: 'run_1',
    nodeId: 'node_1',
    type: 'rollback-plan',
    content: '# Rollback\n',
  });
  await repositories.recordGateResult({
    id: 'gate_1',
    runId: 'run_1',
    nodeId: 'node_1',
    gateType: 'build',
    status: 'passed',
    durationMs: 10,
    retries: 0,
    createdAt: '2026-06-05T00:00:02.000Z',
  });
  await repositories.recordGateResult({
    id: 'gate_2',
    runId: 'run_1',
    nodeId: 'node_1',
    gateType: 'build',
    status: 'failed',
    durationMs: 10,
    retries: 1,
    createdAt: '2026-06-05T00:00:03.000Z',
  });
  await repositories.recordGateResult({
    id: 'gate_3',
    runId: 'run_1',
    nodeId: 'node_1',
    gateType: 'human',
    status: 'passed',
    durationMs: 10,
    retries: 0,
    createdAt: '2026-06-05T00:00:04.000Z',
  });
  await repositories.recordGateResult({
    id: 'gate_4',
    runId: 'run_1',
    nodeId: 'node_1',
    gateType: 'security-scan',
    status: 'passed',
    durationMs: 10,
    retries: 0,
    createdAt: '2026-06-05T00:00:05.000Z',
  });
  await repositories.createHumanDecision({
    id: 'decision_1',
    runId: 'run_1',
    nodeId: 'node_1',
    status: 'approved',
    actor: 'cli',
    note: 'approved',
    createdAt: '2026-06-05T00:00:04.000Z',
    decidedAt: '2026-06-05T00:00:06.000Z',
  });
  await repositories.recordWorktreeLease({
    id: 'lease_1',
    runId: 'run_1',
    nodeId: 'node_1',
    role: 'rd',
    repoPath,
    worktreePath: join(repoPath, '.tekon', 'worktrees', 'lease_1'),
    branchName: 'tekon/run_1/node_1',
    createdAt: '2026-06-05T00:00:01.000Z',
    releasedAt: '2026-06-05T00:00:09.000Z',
  });
  await repositories.upsertDeliveryPullRequest({
    id: 'delivery_pr_1',
    runId: 'run_1',
    branch: 'tekon-delivery/run_1',
    baseBranch: 'main',
    title: 'Refund feature',
    status: 'created',
    prUrl: 'https://github.example/tekon/pull/1',
    approvedBy: 'cli',
    approvedAt: '2026-06-05T00:00:10.000Z',
    branchPushedAt: '2026-06-05T00:00:11.000Z',
    prCreatedAt: '2026-06-05T00:00:12.000Z',
    attemptCount: 1,
    createdAt: '2026-06-05T00:00:09.000Z',
    updatedAt: '2026-06-05T00:00:12.000Z',
  });
  await audit.append({
    runId: 'run_1',
    type: 'run.started',
    payload: {},
    createdAt: '2026-06-05T00:00:01.000Z',
  });
  await audit.append({
    runId: 'run_1',
    type: 'gate.repair.created',
    payload: {},
    createdAt: '2026-06-05T00:00:02.000Z',
  });
}
