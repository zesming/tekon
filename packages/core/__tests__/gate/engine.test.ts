import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandGateway,
  createArtifactStore,
  createGateEngine,
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';

describe('gate engine', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('runs command gates through CommandGateway and persists GateResult', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-engine-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const engine = createGateEngine({
      repositories,
      gateway: createCommandGateway(),
    });

    const result = await engine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: {
        type: 'test',
        command: {
          tool: process.execPath,
          args: ['-e', "process.stdout.write('ok\\n')"],
        },
      },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [{ tool: process.execPath, args: [] }],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({ gateType: 'test', status: 'passed' });
    expect(await repositories.listGateResults('run_1')).toMatchObject([
      { gateType: 'test', status: 'passed' },
    ]);
    db.close();
  });

  it('records explicitly not applicable command gates as skipped', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-skip-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: {
        type: 'build',
        skipReason:
          'repo profile commands.build is not applicable: docs-only repo',
      },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({
      gateType: 'build',
      status: 'skipped',
      failureClassification: 'not-applicable',
    });
    expect(await repositories.listGateResults('run_1')).toMatchObject([
      {
        gateType: 'build',
        status: 'skipped',
        failureClassification: 'not-applicable',
      },
    ]);
    db.close();
  });

  it('does not let skipReason bypass the built-in security scan', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-security-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
      runId: 'run_1',
      nodeId: 'node_1',
      gate: {
        type: 'security-scan',
        skipReason:
          'repo profile commands.security is not applicable: docs-only repo',
      },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    expect(result).toMatchObject({
      gateType: 'security-scan',
      status: 'passed',
      failureClassification: null,
    });
    db.close();
  });

  it('creates an autoFix repair node linked to a failed gate result', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-repair-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    const engine = createGateEngine({ repositories });

    const repair = await engine.createAutoFixRepairNode({
      failedGateResult: {
        id: 'gate_failed',
        runId: 'run_1',
        nodeId: 'node_1',
        gateType: 'test',
        status: 'failed',
        durationMs: 1,
        retries: 1,
        createdAt: '2026-06-05T00:00:00.000Z',
      },
      fixerRole: 'rd',
    });

    expect(repair).toMatchObject({
      role: 'rd',
      status: 'pending',
      dependencies: ['node_1'],
    });
    expect(await repositories.getNode(repair.id)).toMatchObject({ role: 'rd' });
    db.close();
  });

  it('passes independent role-scoped review gates only for separately scoped review artifacts', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-review-scope-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    await repositories.createNode({
      id: 'rd_technical_review',
      runId: 'run_1',
      role: 'rd',
      status: 'running',
      gates: [],
      dependencies: ['node_1'],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    const store = createArtifactStore({ repoPath, repositories });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'rd_technical_review',
      type: 'technical-review',
      content: JSON.stringify({
        title: 'Technical review',
        body: 'The implementation plan is technically feasible.',
        reviewScope: 'technical-design',
        reviewProcess: {
          mode: 'independent-agent',
          reviewerId: 'rd-review-agent-1',
          reviewerRole: 'rd',
          targetNodeId: 'rd_implementation_plan',
          targetRole: 'rd',
        },
        decision: 'approved',
      }),
    });
    const engine = createGateEngine({ repositories });

    const independent = await engine.runGate({
      runId: 'run_1',
      nodeId: 'rd_technical_review',
      gate: { type: 'independent-review', artifactType: 'technical-review' },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });
    const scoped = await engine.runGate({
      runId: 'run_1',
      nodeId: 'rd_technical_review',
      gate: { type: 'role-scope', artifactType: 'technical-review' },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    expect(independent).toMatchObject({
      gateType: 'independent-review',
      status: 'passed',
    });
    expect(scoped).toMatchObject({ gateType: 'role-scope', status: 'passed' });

    await repositories.createNode({
      id: 'pm_wrong_scope_review',
      runId: 'run_1',
      role: 'pm',
      status: 'running',
      gates: [],
      dependencies: ['node_1'],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'pm_wrong_scope_review',
      type: 'technical-review',
      content: JSON.stringify({
        title: 'Out of scope review',
        body: 'PM should not approve RD technical design.',
        reviewScope: 'technical-design',
        reviewProcess: {
          mode: 'independent-agent',
          reviewerId: 'pm-review-agent-1',
          reviewerRole: 'pm',
          targetNodeId: 'rd_implementation_plan',
          targetRole: 'rd',
        },
        decision: 'approved',
      }),
    });

    const wrongScope = await engine.runGate({
      runId: 'run_1',
      nodeId: 'pm_wrong_scope_review',
      gate: { type: 'role-scope', artifactType: 'technical-review' },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    expect(wrongScope).toMatchObject({
      gateType: 'role-scope',
      status: 'failed',
      failureClassification: 'role-scope-violation',
    });
    expect(readFileSync(wrongScope.outputPath!, 'utf8')).toContain(
      'technical-design is not allowed for pm',
    );
    db.close();
  });

  it('requires AC evidence and QA signoff to bind passed evidence to the delivered ref', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-ac-signoff-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    await repositories.createNode({
      id: 'qa_signoff',
      runId: 'run_1',
      role: 'qa',
      status: 'running',
      gates: [],
      dependencies: ['node_1'],
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
        body: 'Standard delivery requirements.',
        acceptanceCriteria: [
          { id: 'AC-1', description: 'The template can be loaded.' },
          { id: 'AC-2', description: 'The delivery flow is reviewable.' },
        ],
      }),
    });
    await repositories.recordGateResult({
      id: 'gate_test',
      runId: 'run_1',
      nodeId: 'qa_signoff',
      gateType: 'test',
      status: 'passed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.000Z',
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'qa_signoff',
      type: 'ac-evidence',
      content: JSON.stringify({
        title: 'AC evidence',
        body: 'Both acceptance criteria have direct evidence.',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Template unit test passed.',
            gateResultIds: ['gate_test'],
          },
          {
            criterionId: 'AC-2',
            status: 'passed',
            evidence: 'Review package includes the standard flow.',
          },
        ],
      }),
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'qa_signoff',
      type: 'qa-release-signoff',
      content: JSON.stringify({
        title: 'QA release signoff',
        body: 'The tested ref equals the delivered ref.',
        targetRef: 'sha:cafebabe',
        validatedRef: 'sha:cafebabe',
        overallStatus: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Validated on sha:cafebabe.',
          },
          {
            criterionId: 'AC-2',
            status: 'passed',
            evidence: 'Validated on sha:cafebabe.',
          },
        ],
      }),
    });
    const engine = createGateEngine({ repositories });

    const acEvidence = await engine.runGate({
      runId: 'run_1',
      nodeId: 'qa_signoff',
      gate: { type: 'ac-evidence', artifactType: 'ac-evidence' },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });
    const qaSignoff = await engine.runGate({
      runId: 'run_1',
      nodeId: 'qa_signoff',
      gate: { type: 'qa-signoff', artifactType: 'qa-release-signoff' },
      cwd: repoPath,
      outputDir: join(repoPath, '.tekon', 'runs', 'run_1', 'gates'),
      policy: {
        allow: [],
        deny: [],
        requiresHumanApproval: [],
        cwdScope: [repoPath],
        network: 'disabled',
      },
    });

    expect(acEvidence).toMatchObject({
      gateType: 'ac-evidence',
      status: 'passed',
    });
    expect(qaSignoff).toMatchObject({
      gateType: 'qa-signoff',
      status: 'passed',
    });
    db.close();
  });
});

async function createRunFixture(
  repositories: ReturnType<typeof createRepositories>,
  repoPath: string,
) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Gate engine',
    body: 'Run gates.',
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
    status: 'running',
    currentNodeId: 'node_1',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    role: 'rd',
    status: 'running',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
}
