import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createAuditLogger,
  createPullRequestPreparation,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('pull request preparation package', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('creates a reviewable PR body and delivery-package artifact without remote side effects', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-pr-package-'));
    tempDirs.push(repoPath);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await repositories.createDemand({
      id: 'demand_1',
      title: 'Add retry action',
      body: 'Add a safe retry action for failed tasks.',
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
      id: 'node_delivery',
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
      nodeId: 'node_delivery',
      type: 'test-report',
      content: '# Test Report\n\npassed',
    });
    await repositories.recordGateResult({
      id: 'gate_1',
      runId: 'run_1',
      nodeId: 'node_delivery',
      gateType: 'test',
      status: 'passed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_skipped_e2e',
      runId: 'run_1',
      nodeId: 'node_delivery',
      gateType: 'e2e-pass',
      status: 'skipped',
      durationMs: 1,
      retries: 0,
      failureClassification: 'not-applicable',
      createdAt: '2026-06-05T00:00:01.100Z',
    });
    await audit.append({
      runId: 'run_1',
      type: 'run.passed',
      payload: {},
      createdAt: '2026-06-05T00:00:02.000Z',
    });

    const preparation = await createPullRequestPreparation({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
      profile: {
        version: 1,
        commands: {
          build: { tool: 'pnpm', args: ['build'] },
          test: { tool: 'pnpm', args: ['test'] },
          e2e: {
            notApplicable: true,
            reason: 'service has no browser surface',
          },
        },
        pr: { baseBranch: 'main', titlePrefix: '[Donkey] ' },
        risks: { highRiskPaths: [], requiresHumanApproval: [] },
      },
    });

    expect(preparation).toMatchObject({
      runId: 'run_1',
      title: '[Donkey] Add retry action',
      branch: 'donkey-delivery/run_1',
      baseBranch: 'main',
      requiresHumanApproval: true,
    });
    expect(existsSync(preparation.packagePath)).toBe(true);
    expect(existsSync(preparation.prBodyPath)).toBe(true);
    expect(readFileSync(preparation.prBodyPath, 'utf8')).toContain(
      'remote push and PR creation require human approval',
    );
    expect(readFileSync(preparation.prBodyPath, 'utf8')).toContain(
      '- gates: 1 passed, 1 skipped, 0 failed_or_blocked',
    );
    expect(readFileSync(preparation.packagePath, 'utf8')).toContain(
      'Acceptance Evidence',
    );
    expect(readFileSync(preparation.packagePath, 'utf8')).toContain(
      '- e2e: notApplicable reason=service has no browser surface',
    );
    expect(
      await repositories.listArtifacts('run_1', undefined, 'delivery-package'),
    ).toHaveLength(1);
    expect((await audit.verify('run_1')).valid).toBe(true);
    db.close();
  });
});
