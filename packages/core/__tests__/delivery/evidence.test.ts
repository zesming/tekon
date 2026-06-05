import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createAuditLogger,
  createDeliveryEvidencePackage,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('delivery evidence package', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('summarizes demand, workflow, artifacts, gates, audit verification, risk gates, and rollback plan', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-evidence-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await repositories.createDemand({
      id: 'demand_1',
      title: 'Refund feature',
      body: 'Add refund support.',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_1',
      name: 'donkey',
      repoPath,
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createWorkflowInstance({
      id: 'run_1',
      projectId: 'project_1',
      demandId: 'demand_1',
      status: 'passed',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'node_1',
      runId: 'run_1',
      role: 'pmo',
      status: 'passed',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
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
      gateType: 'human',
      status: 'passed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.000Z',
    });
    await audit.append({
      runId: 'run_1',
      type: 'run.passed',
      payload: {},
      createdAt: '2026-06-05T00:00:02.000Z',
    });

    const evidence = await createDeliveryEvidencePackage({
      repositories,
      audit,
      runId: 'run_1',
      riskGates: ['human'],
      testOutputPaths: ['test-results/core.log'],
    });

    expect(evidence).toMatchObject({
      runId: 'run_1',
      workflowStatus: 'passed',
      demand: { title: 'Refund feature' },
      audit: { valid: true },
      rollbackPlanPresent: true,
      riskGates: ['human'],
      testOutputPaths: ['test-results/core.log'],
    });
    expect(evidence.artifacts.map((artifact) => artifact.type)).toEqual([
      'delivery-package',
      'rollback-plan',
    ]);
    expect(evidence.gates).toHaveLength(1);
  });
});
