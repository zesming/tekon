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
          { id: 'AC-2', description: 'Batch retry result can be reviewed.' },
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
          {
            criterionId: 'AC-2',
            status: 'passed',
            evidence: 'Review tests covered batch retry evidence.',
          },
        ],
      }),
    });
    await repositories.recordGateResult({
      id: 'gate_failed_then_repaired',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'test',
      gateKey: '00:test:unit',
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
      gateKey: '00:test:unit',
      status: 'passed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_secondary_test',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'test',
      gateKey: '01:test:integration',
      status: 'passed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.010Z',
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
    for (const [index, gateType] of [
      'independent-review',
      'role-scope',
      'ac-evidence',
      'process-completeness',
    ].entries()) {
      await repositories.recordGateResult({
        id: `gate_governance_${gateType}`,
        runId: 'run_1',
        nodeId: 'node_1',
        gateType,
        status: 'passed',
        durationMs: 1,
        retries: 0,
        createdAt: `2026-06-05T00:00:01.${220 + index}Z`,
      });
    }
    await audit.append({
      runId: 'run_1',
      type: 'run.started',
      payload: { templateId: 'standard-delivery', mode: 'template' },
      createdAt: '2026-06-05T00:00:01.500Z',
    });
    await audit.append({
      runId: 'run_1',
      type: 'run.passed',
      payload: {},
      createdAt: '2026-06-05T00:00:02.000Z',
    });
    await audit.append({
      runId: 'run_1',
      type: 'qa.validation.ref',
      payload: {
        nodeId: 'node_1',
        ref: 'branch:tekon-delivery/run_1',
      },
      createdAt: '2026-06-05T00:00:02.100Z',
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

    await expect(
      createPullRequestPreparation({
        repoPath,
        repositories,
        audit,
        runId: 'run_1',
      }),
    ).rejects.toThrow('qa-release-signoff-passed');

    const beforeSignoff = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(beforeSignoff.ready).toBe(false);
    expect(
      beforeSignoff.checks.find(
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
    const afterPartialSignoff = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(afterPartialSignoff.ready).toBe(false);
    expect(
      afterPartialSignoff.checks.find(
        (check) => check.id === 'qa-release-signoff-passed',
      ),
    ).toMatchObject({
      severity: 'required',
      passed: false,
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
            gateResultIds: ['gate_1'],
          },
          {
            criterionId: 'AC-2',
            status: 'passed',
            evidence: 'QA review passed for branch:tekon-delivery/run_1.',
            gateResultIds: ['gate_1'],
          },
        ],
      }),
    });
    const afterFullSignoffBeforeGate = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(afterFullSignoffBeforeGate.ready).toBe(false);
    expect(
      afterFullSignoffBeforeGate.checks.find(
        (check) => check.id === 'qa-release-signoff-passed',
      ),
    ).toMatchObject({
      severity: 'required',
      passed: false,
      evidence: expect.stringContaining('qa-signoff gate missing'),
    });

    await repositories.recordGateResult({
      id: 'gate_qa_signoff',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'qa-signoff',
      status: 'passed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.300Z',
    });
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

    expect(afterPrepare.ready).toBe(false);
    expect(
      afterPrepare.checks.find(
        (check) => check.id === 'validation-gates-passed',
      ),
    ).toMatchObject({
      passed: true,
      evidence: '3/3 validation gates passed or explicitly skipped',
    });
    expect(
      afterPrepare.checks.find((check) => check.id === 'pr-created'),
    ).toMatchObject({
      severity: 'required',
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
    expect(afterPr.ready).toBe(false);
    expect(
      afterPr.checks.find((check) => check.id === 'pr-created'),
    ).toMatchObject({
      severity: 'required',
      passed: true,
      evidence: 'PR created: https://github.example/tekon/pull/1',
    });
    expect(
      afterPr.checks.find((check) => check.id === 'remote-ci-passed'),
    ).toMatchObject({
      severity: 'required',
      passed: false,
    });

    const ciArtifact = await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'ci-status',
      content: JSON.stringify({
        title: 'CI status',
        body: 'Remote CI passed.',
        ciStatus: 'passed',
        prUrl: 'https://github.example/tekon/pull/1',
        checkedAt: '2026-06-05T00:00:06.000Z',
        checks: [{ name: 'build', bucket: 'pass' }],
      }),
    });
    await audit.append({
      runId: 'run_1',
      type: 'delivery.ci.checked',
      payload: { artifactId: ciArtifact.id },
    });
    const afterCi = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
    });
    expect(afterCi.ready).toBe(true);
    expect(
      afterCi.checks.find((check) => check.id === 'remote-ci-passed'),
    ).toMatchObject({
      severity: 'required',
      passed: true,
    });
    db.close();
  });
});
