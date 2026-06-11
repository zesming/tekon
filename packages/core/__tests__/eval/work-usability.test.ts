import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createAuditLogger,
  createPullRequestPreparation,
  createRepositories,
  evaluateWorkUsability,
  migrateDatabase,
  openTekonDatabase,
  renderWorkUsabilityEvaluationReport,
  type TekonRepositories,
  upsertWorkUsabilitySample,
} from '../../src/index.js';

describe('work usability evaluation', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('passes when sample thresholds, readiness, PR evidence, and isolation evidence are satisfied', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-work-usable-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedReadyRun({
      repoPath,
      repositories,
      runId: 'run_real',
      provider: 'claude-code',
      prUrl: 'https://github.example/tekon/pull/42',
    });
    await audit.append({
      runId: 'run_real',
      type: 'run.passed',
      payload: {},
      createdAt: '2026-06-08T00:00:02.000Z',
    });
    await createPullRequestPreparation({
      repoPath,
      repositories,
      audit,
      runId: 'run_real',
    });

    const evaluation = await evaluateWorkUsability({
      repoPath,
      repositories,
      audit,
      sampleSet: {
        thresholds: {
          minSamples: 1,
          minReadyRuns: 1,
          minRealProviderRuns: 1,
          minCreatedPrs: 1,
          requireIsolationEvidence: true,
        },
        samples: [
          {
            id: 'sample-real-1',
            runId: 'run_real',
            expectedProvider: 'claude-code',
            requireRealProvider: true,
            requirePr: true,
            expectedPrUrl: 'https://github.example/tekon/pull/42',
          },
        ],
      },
    });

    expect(evaluation.usable).toBe(true);
    expect(evaluation.counts).toMatchObject({
      samples: 1,
      readyRuns: 1,
      realProviderRuns: 1,
      createdPrs: 1,
      securityScanPassed: 1,
      isolationPassed: 1,
    });
    expect(evaluation.thresholdChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'sample-count', passed: true }),
        expect.objectContaining({ id: 'created-pr-count', passed: true }),
        expect.objectContaining({ id: 'isolation-evidence', passed: true }),
      ]),
    );
    db.close();
  });

  it('keeps work usability false when real provider, PR, or isolation evidence is missing', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-work-not-usable-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedReadyRun({
      repoPath,
      repositories,
      runId: 'run_mock',
      provider: 'mock',
      prUrl: null,
      recordLease: false,
    });
    await audit.append({
      runId: 'run_mock',
      type: 'run.passed',
      payload: {},
      createdAt: '2026-06-08T00:00:02.000Z',
    });
    await createPullRequestPreparation({
      repoPath,
      repositories,
      audit,
      runId: 'run_mock',
    });

    const evaluation = await evaluateWorkUsability({
      repoPath,
      repositories,
      audit,
      sampleSet: {
        thresholds: {
          minSamples: 1,
          minReadyRuns: 1,
          minRealProviderRuns: 1,
          minCreatedPrs: 1,
          requireIsolationEvidence: true,
        },
        samples: [
          {
            id: 'sample-mock-1',
            runId: 'run_mock',
            requireRealProvider: true,
            requirePr: true,
          },
        ],
      },
    });

    expect(evaluation.usable).toBe(false);
    expect(evaluation.thresholdChecks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'real-provider-run-count',
          passed: false,
        }),
        expect.objectContaining({ id: 'created-pr-count', passed: false }),
        expect.objectContaining({ id: 'isolation-evidence', passed: false }),
        expect.objectContaining({
          id: 'sample-required-checks',
          passed: false,
        }),
      ]),
    );
    expect(evaluation.samples[0]?.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'real-provider-required',
          passed: false,
        }),
        expect.objectContaining({ id: 'pr-required', passed: false }),
        expect.objectContaining({
          id: 'worktree-lease-present',
          passed: false,
        }),
      ]),
    );
    db.close();
  });

  it('records missing runs as failed sample evidence', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-work-missing-run-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const evaluation = await evaluateWorkUsability({
      repoPath,
      repositories,
      audit,
      sampleSet: {
        thresholds: { minSamples: 1, requireIsolationEvidence: false },
        samples: [{ id: 'missing', runId: 'run_missing' }],
      },
    });

    expect(evaluation.usable).toBe(false);
    expect(evaluation.samples[0]).toMatchObject({
      runPresent: false,
      readiness: null,
    });
    expect(evaluation.samples[0]?.checks).toContainEqual(
      expect.objectContaining({ id: 'run-present', passed: false }),
    );
    db.close();
  });

  it('upserts samples by id and preserves configured thresholds', () => {
    const result = upsertWorkUsabilitySample(
      {
        thresholds: { minSamples: 2, minCreatedPrs: 1 },
        samples: [
          {
            id: 'sample-1',
            runId: 'run_old',
            requireRealProvider: false,
            requirePr: false,
          },
        ],
      },
      {
        id: 'sample-1',
        runId: 'run_new',
        expectedProvider: 'claude-code',
        requireRealProvider: true,
        requirePr: true,
        expectedPrUrl: 'https://github.example/tekon/pull/7',
      },
    );

    expect(result.created).toBe(false);
    expect(result.sampleSet.thresholds).toMatchObject({
      minSamples: 2,
      minCreatedPrs: 1,
    });
    expect(result.sampleSet.samples).toHaveLength(1);
    expect(result.sampleSet.samples[0]).toMatchObject({
      id: 'sample-1',
      runId: 'run_new',
      expectedProvider: 'claude-code',
      requireRealProvider: true,
      requirePr: true,
    });
  });

  it('accepts Codex as a first-class expected provider in sample records', () => {
    const result = upsertWorkUsabilitySample(
      {
        thresholds: { minSamples: 1, minRealProviderRuns: 1 },
        samples: [],
      },
      {
        id: 'codex-self-bootstrap-1',
        runId: 'run_codex',
        expectedProvider: 'codex',
        requireRealProvider: true,
        requirePr: true,
        expectedPrUrl: 'https://github.example/tekon/pull/99',
      },
    );

    expect(result.created).toBe(true);
    expect(result.sampleSet.samples).toEqual([
      expect.objectContaining({
        id: 'codex-self-bootstrap-1',
        expectedProvider: 'codex',
        requireRealProvider: true,
        requirePr: true,
      }),
    ]);
  });

  it('renders a bounded work usability report with failed checks visible', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-work-report-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });

    const evaluation = await evaluateWorkUsability({
      repoPath,
      repositories,
      audit,
      sampleSet: {
        thresholds: {
          minSamples: 1,
          minReadyRuns: 1,
          minRealProviderRuns: 1,
          minCreatedPrs: 1,
          requireIsolationEvidence: true,
        },
        samples: [{ id: 'missing', runId: 'run_missing' }],
      },
    });

    const report = renderWorkUsabilityEvaluationReport({
      title: 'Fixture <Work Usability>',
      generatedAt: '2026-06-08T00:00:00.000Z',
      samplePath: '/tmp/work-usability-samples.yaml',
      evaluation,
    });

    expect(report.markdown).toContain('# Fixture <Work Usability>');
    expect(report.markdown).toContain('usable: false');
    expect(report.markdown).toContain('missing:run-present');
    expect(report.markdown).toContain(
      'does not yet satisfy the configured work usability thresholds',
    );
    expect(report.html).toContain('Fixture &lt;Work Usability&gt;');
    expect(report.html).toContain('run not found: run_missing');
    expect(report.html).toContain('does not prove production readiness');
    db.close();
  });
});

async function seedReadyRun(input: {
  repoPath: string;
  repositories: TekonRepositories;
  runId: string;
  provider: 'mock' | 'claude-code';
  prUrl: string | null;
  recordLease?: boolean;
}) {
  await input.repositories.createDemand({
    id: `demand_${input.runId}`,
    title: 'Batch retry',
    body: 'Add batch retry.',
    createdAt: '2026-06-08T00:00:00.000Z',
  });
  await input.repositories.createProject({
    id: `project_${input.runId}`,
    name: 'fixture',
    repoPath: input.repoPath,
    createdAt: '2026-06-08T00:00:00.000Z',
  });
  await input.repositories.createWorkflowInstance({
    id: input.runId,
    projectId: `project_${input.runId}`,
    demandId: `demand_${input.runId}`,
    status: 'passed',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:01.000Z',
  });
  await input.repositories.recordRunProviderConfig({
    runId: input.runId,
    provider: input.provider,
    configSummary: { provider: input.provider },
    createdAt: '2026-06-08T00:00:00.100Z',
  });
  await input.repositories.createNode({
    id: `node_${input.runId}`,
    runId: input.runId,
    role: 'rd',
    status: 'passed',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:01.000Z',
  });
  const store = createArtifactStore({
    repoPath: input.repoPath,
    repositories: input.repositories,
  });
  await store.writeArtifact({
    runId: input.runId,
    nodeId: `node_${input.runId}`,
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
    runId: input.runId,
    nodeId: `node_${input.runId}`,
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
  await input.repositories.recordGateResult({
    id: `gate_test_${input.runId}`,
    runId: input.runId,
    nodeId: `node_${input.runId}`,
    gateType: 'test',
    status: 'passed',
    durationMs: 1,
    retries: 0,
    createdAt: '2026-06-08T00:00:01.000Z',
  });
  await input.repositories.recordGateResult({
    id: `gate_security_${input.runId}`,
    runId: input.runId,
    nodeId: `node_${input.runId}`,
    gateType: 'security-scan',
    status: 'passed',
    durationMs: 1,
    retries: 0,
    createdAt: '2026-06-08T00:00:01.100Z',
  });
  if (input.recordLease !== false) {
    await input.repositories.recordWorktreeLease({
      id: `lease_${input.runId}`,
      runId: input.runId,
      nodeId: `node_${input.runId}`,
      role: 'rd',
      repoPath: input.repoPath,
      worktreePath: join(
        input.repoPath,
        '.tekon',
        'worktrees',
        input.runId,
        'node-rd-lease',
      ),
      branchName: `tekon/${input.runId}/node-rd-lease`,
      createdAt: '2026-06-08T00:00:00.200Z',
      releasedAt: '2026-06-08T00:00:01.200Z',
    });
  }
  if (input.prUrl) {
    await input.repositories.upsertDeliveryPullRequest({
      id: `delivery_pr_${input.runId}`,
      runId: input.runId,
      branch: `tekon-delivery/${input.runId}`,
      baseBranch: 'main',
      title: 'Batch retry',
      status: 'created',
      prUrl: input.prUrl,
      approvedBy: 'cli',
      approvedAt: '2026-06-08T00:00:03.000Z',
      branchPushedAt: '2026-06-08T00:00:04.000Z',
      prCreatedAt: '2026-06-08T00:00:05.000Z',
      attemptCount: 1,
      createdAt: '2026-06-08T00:00:03.000Z',
      updatedAt: '2026-06-08T00:00:05.000Z',
    });
  }
}
