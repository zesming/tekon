import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createAuditLogger,
  createPullRequestPreparation,
  createRepositories,
  evaluateWorkReadiness,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('work readiness evaluation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('requires passed workflow, valid audit, validation gates, delivery package, PR preparation, and no pending human gates', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-work-ready-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await repositories.createDemand({
      id: 'demand_1',
      title: 'Batch retry',
      body: 'Add batch retry.',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_1',
      name: 'fixture',
      repoPath,
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createWorkflowInstance({
      id: 'run_1',
      projectId: 'project_1',
      demandId: 'demand_1',
      status: 'passed',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:01.000Z',
    });
    await repositories.createNode({
      id: 'node_1',
      runId: 'run_1',
      role: 'pmo',
      status: 'passed',
      gates: [],
      dependencies: [],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:01.000Z',
    });
    const store = createArtifactStore({ repoPath, repositories });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'test-report',
      content: '# Tests\n\npassed',
    });
    await repositories.recordGateResult({
      id: 'gate_failed_then_repaired',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'test',
      status: 'failed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:00.500Z',
    });
    await repositories.recordGateResult({
      id: 'gate_1',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'test',
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

    const beforePrepare = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
    });
    expect(beforePrepare.ready).toBe(false);
    expect(
      beforePrepare.checks.find((check) => check.id === 'pr-prepared'),
    ).toMatchObject({ passed: false });

    await createPullRequestPreparation({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
    });
    const afterPrepare = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(afterPrepare.ready).toBe(true);
    expect(afterPrepare.score).toBe(1);
    db.close();
  });
});
