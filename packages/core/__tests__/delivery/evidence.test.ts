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
  openTekonDatabase,
} from '../../src/index.js';

describe('delivery evidence package', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('summarizes demand, workflow, artifacts, gates, audit verification, risk gates, and rollback plan', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-evidence-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
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
      type: 'prd',
      content: JSON.stringify({
        title: 'PRD',
        body: 'Refund requirements.',
        acceptanceCriteria: [
          { id: 'AC-1', description: 'Refunds can be requested.' },
        ],
      }),
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'test-report',
      content: JSON.stringify({
        title: 'Tests',
        body: 'Refund tests passed.',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Unit tests covered refund request.',
            gateResultIds: ['gate_2'],
          },
        ],
      }),
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'delivery-package',
      content: JSON.stringify({
        title: 'Delivery',
        body: 'Delivery package.',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Delivery package includes refund evidence.',
          },
        ],
      }),
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'qa-release-signoff',
      content: JSON.stringify({
        title: 'QA signoff',
        body: 'QA validated the delivered ref.',
        targetRef: 'sha:feedface',
        validatedRef: 'sha:feedface',
        overallStatus: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'QA validation covered refund request on sha:feedface.',
          },
        ],
      }),
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
    await repositories.recordGateResult({
      id: 'gate_2',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'test',
      status: 'passed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.500Z',
    });
    await repositories.recordGateResult({
      id: 'gate_3',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'security-scan',
      status: 'passed',
      outputPath: '.tekon/runs/run_1/gates/security.log',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.600Z',
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
    expect(evidence.artifacts.map((artifact) => artifact.type).sort()).toEqual([
      'delivery-package',
      'prd',
      'qa-release-signoff',
      'rollback-plan',
      'test-report',
    ]);
    expect(evidence.gates).toHaveLength(3);
    expect(evidence.acceptanceCriteria).toEqual([
      { id: 'AC-1', description: 'Refunds can be requested.' },
    ]);
    expect(evidence.acceptanceEvidence).toEqual([
      expect.objectContaining({
        criterionId: 'AC-1',
        status: 'passed',
        evidence: expect.arrayContaining([
          'Unit tests covered refund request.',
          'Delivery package includes refund evidence.',
        ]),
        gateResultIds: ['gate_2'],
      }),
    ]);
    expect(evidence.securityScans).toEqual([
      expect.objectContaining({ gateResultId: 'gate_3', status: 'passed' }),
    ]);
    expect(evidence.qaReleaseSignoffs).toEqual([
      expect.objectContaining({
        artifactId: expect.any(String),
        status: 'passed',
        targetRef: 'sha:feedface',
        validatedRef: 'sha:feedface',
        matchedRef: true,
      }),
    ]);
  });

  it('keeps latest gate evidence separate by stable gate key', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-evidence-gates-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await repositories.createDemand({
      id: 'demand_1',
      title: 'Security evidence',
      body: 'Keep keyed security gates.',
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
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'rd-code',
      runId: 'run_1',
      role: 'rd',
      status: 'passed',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_secret_scan',
      runId: 'run_1',
      nodeId: 'rd-code',
      gateType: 'security-scan',
      gateKey: '00:security-scan:commandRef=secret-scan',
      status: 'passed',
      outputPath: '.tekon/runs/run_1/gates/secrets.log',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_dependency_scan',
      runId: 'run_1',
      nodeId: 'rd-code',
      gateType: 'security-scan',
      gateKey: '01:security-scan:commandRef=dependency-scan',
      status: 'passed',
      outputPath: '.tekon/runs/run_1/gates/dependencies.log',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:02.000Z',
    });

    const evidence = await createDeliveryEvidencePackage({
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(evidence.securityScans.map((scan) => scan.gateResultId)).toEqual([
      'gate_secret_scan',
      'gate_dependency_scan',
    ]);
    db.close();
  });
});
