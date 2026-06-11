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
  openTekonDatabase,
} from '../../src/index.js';

describe('work readiness evaluation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('requires passed workflow, valid audit, validation gates, delivery package, PR preparation, and no pending human gates', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-work-ready-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
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
      type: 'prd',
      content: JSON.stringify({
        title: 'PRD',
        body: 'Batch retry requirements.',
        acceptanceCriteria: [
          { id: 'AC-1', description: 'Batch retry can be executed.' },
        ],
      }),
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'test-report',
      content: JSON.stringify({
        title: 'Tests',
        body: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Unit tests covered batch retry.',
          },
        ],
      }),
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
    await repositories.recordGateResult({
      id: 'gate_docs_only_build',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'build',
      status: 'skipped',
      durationMs: 1,
      retries: 0,
      failureClassification: 'not-applicable',
      createdAt: '2026-06-05T00:00:01.050Z',
    });
    await repositories.recordGateResult({
      id: 'gate_security',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'security-scan',
      status: 'failed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.100Z',
    });
    await repositories.recordGateResult({
      id: 'gate_security_repaired',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'security-scan',
      status: 'passed',
      durationMs: 1,
      retries: 1,
      createdAt: '2026-06-05T00:00:01.200Z',
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
    const afterPrepareBeforeSignoff = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(afterPrepareBeforeSignoff.ready).toBe(false);
    expect(
      afterPrepareBeforeSignoff.checks.find(
        (check) => check.id === 'qa-release-signoff-passed',
      ),
    ).toMatchObject({
      severity: 'required',
      passed: false,
      evidence: 'QA release signoff missing',
    });

    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'qa-release-signoff',
      content: JSON.stringify({
        title: 'QA release signoff',
        body: 'QA validated the branch that will be delivered.',
        targetRef: 'branch:tekon-delivery/run_1',
        validatedRef: 'branch:tekon-delivery/run_1',
        overallStatus: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'QA validation passed for branch:tekon-delivery/run_1.',
          },
        ],
      }),
    });
    const afterPrepare = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(afterPrepare.ready).toBe(true);
    expect(
      afterPrepare.checks.find(
        (check) => check.id === 'validation-gates-passed',
      ),
    ).toMatchObject({
      passed: true,
      evidence: '2/2 validation gates passed or explicitly skipped',
    });
    expect(
      afterPrepare.checks.find((check) => check.id === 'pr-created'),
    ).toMatchObject({
      severity: 'recommended',
      passed: false,
    });

    await repositories.upsertDeliveryPullRequest({
      id: 'delivery_pr_1',
      runId: 'run_1',
      branch: 'tekon-delivery/run_1',
      baseBranch: 'main',
      title: 'Batch retry',
      status: 'created',
      prUrl: 'https://github.example/tekon/pull/1',
      approvedBy: 'cli',
      approvedAt: '2026-06-05T00:00:03.000Z',
      branchPushedAt: '2026-06-05T00:00:04.000Z',
      prCreatedAt: '2026-06-05T00:00:05.000Z',
      attemptCount: 1,
      createdAt: '2026-06-05T00:00:03.000Z',
      updatedAt: '2026-06-05T00:00:05.000Z',
    });
    const afterPr = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
    });
    expect(afterPr.ready).toBe(true);
    expect(
      afterPr.checks.find((check) => check.id === 'pr-created'),
    ).toMatchObject({
      passed: true,
      evidence: 'PR created: https://github.example/tekon/pull/1',
    });
    db.close();
  });
});
