import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createCommandGateway,
  createArtifactStore,
  createAuditLogger,
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
      id: 'rd_implementation_plan',
      runId: 'run_1',
      role: 'rd',
      status: 'passed',
      outputs: [{ id: 'implementation-plan', type: 'implementation-plan' }],
      gates: [],
      dependencies: ['node_1'],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'rd_technical_review',
      runId: 'run_1',
      role: 'rd',
      status: 'running',
      inputs: [
        {
          id: 'implementation-plan',
          type: 'implementation-plan',
          fromNodeId: 'rd_implementation_plan',
        },
      ],
      gates: [],
      dependencies: ['node_1'],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createRoleRun({
      id: 'role_run_review',
      runId: 'run_1',
      nodeId: 'rd_technical_review',
      role: 'rd',
      status: 'passed',
      startedAt: '2026-06-05T00:00:00.100Z',
      completedAt: '2026-06-05T00:00:00.200Z',
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

    await repositories.createNode({
      id: 'rd_code_change',
      runId: 'run_1',
      role: 'rd',
      status: 'passed',
      outputs: [{ id: 'code', type: 'code-changes' }],
      gates: [],
      dependencies: ['rd_implementation_plan'],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'reviewer_wrong_target',
      runId: 'run_1',
      role: 'reviewer',
      status: 'running',
      inputs: [
        {
          id: 'implementation-plan',
          type: 'implementation-plan',
          fromNodeId: 'rd_implementation_plan',
        },
        {
          id: 'code',
          type: 'code-changes',
          fromNodeId: 'rd_code_change',
        },
      ],
      gates: [],
      dependencies: ['rd_code_change'],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createRoleRun({
      id: 'role_run_wrong_target',
      runId: 'run_1',
      nodeId: 'reviewer_wrong_target',
      role: 'reviewer',
      status: 'passed',
      startedAt: '2026-06-05T00:00:00.100Z',
      completedAt: '2026-06-05T00:00:00.200Z',
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'reviewer_wrong_target',
      type: 'code-review',
      content: JSON.stringify({
        title: 'Code review',
        body: 'This incorrectly targets the implementation plan.',
        reviewScope: 'code-change',
        reviewProcess: {
          mode: 'independent-agent',
          reviewerId: 'reviewer-agent-1',
          reviewerRole: 'reviewer',
          targetNodeId: 'rd_implementation_plan',
          targetRole: 'rd',
        },
        decision: 'approved',
      }),
    });

    const wrongTarget = await engine.runGate({
      runId: 'run_1',
      nodeId: 'reviewer_wrong_target',
      gate: { type: 'independent-review', artifactType: 'code-review' },
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

    expect(wrongTarget).toMatchObject({
      gateType: 'independent-review',
      status: 'failed',
      failureClassification: 'review-target-artifact-mismatch',
    });
    db.close();
  });

  it('rejects independent review artifacts without a completed reviewer role run', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-review-run-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    await repositories.createNode({
      id: 'rd_implementation_plan',
      runId: 'run_1',
      role: 'rd',
      status: 'passed',
      gates: [],
      dependencies: ['node_1'],
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createNode({
      id: 'rd_technical_review',
      runId: 'run_1',
      role: 'rd',
      status: 'running',
      inputs: [
        {
          id: 'implementation-plan',
          type: 'implementation-plan',
          fromNodeId: 'rd_implementation_plan',
        },
      ],
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

    const result = await engine.runGate({
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

    expect(result).toMatchObject({
      gateType: 'independent-review',
      status: 'failed',
      failureClassification: 'missing-reviewer-role-run',
    });
    db.close();
  });

  it('rejects independent review artifacts that target missing workflow nodes', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-review-target-'));
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
    await repositories.createRoleRun({
      id: 'role_run_review_missing_target',
      runId: 'run_1',
      nodeId: 'rd_technical_review',
      role: 'rd',
      status: 'passed',
      startedAt: '2026-06-05T00:00:00.100Z',
      completedAt: '2026-06-05T00:00:00.200Z',
    });
    const store = createArtifactStore({ repoPath, repositories });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'rd_technical_review',
      type: 'technical-review',
      content: JSON.stringify({
        title: 'Technical review',
        body: 'This claims to review a missing node.',
        reviewScope: 'technical-design',
        reviewProcess: {
          mode: 'independent-agent',
          reviewerId: 'rd-review-agent-1',
          reviewerRole: 'rd',
          targetNodeId: 'missing_plan_node',
          targetRole: 'rd',
        },
        decision: 'approved',
      }),
    });
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
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

    expect(result).toMatchObject({
      gateType: 'independent-review',
      status: 'failed',
      failureClassification: 'missing-review-target',
    });
    db.close();
  });

  it('requires AC evidence and QA signoff to bind passed evidence to the delivered ref', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-ac-signoff-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await createRunFixture(repositories, repoPath);
    await audit.append({
      runId: 'run_1',
      type: 'qa.validation.ref',
      payload: { nodeId: 'qa_validation', ref: 'sha:cafebabe' },
    });
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
            gateResultIds: ['gate_test'],
          },
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
            gateResultIds: ['gate_test'],
          },
          {
            criterionId: 'AC-2',
            status: 'passed',
            evidence: 'Validated on sha:cafebabe.',
            gateResultIds: ['gate_test'],
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

  it('requires current AC evidence artifact to cover every acceptance criterion', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-ac-missing-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    await repositories.createNode({
      id: 'qa_validation',
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
        body: 'Two acceptance criteria.',
        acceptanceCriteria: [
          { id: 'AC-1', description: 'First criterion.' },
          { id: 'AC-2', description: 'Second criterion.' },
        ],
      }),
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'test-report',
      content: JSON.stringify({
        title: 'Old tests',
        body: 'This should not satisfy the current ac-evidence gate.',
        criteriaEvidence: [
          {
            criterionId: 'AC-2',
            status: 'passed',
            evidence: 'Old test evidence from another node.',
          },
        ],
      }),
    });
    await repositories.recordGateResult({
      id: 'gate_test',
      runId: 'run_1',
      nodeId: 'qa_validation',
      gateType: 'test',
      status: 'passed',
      durationMs: 1,
      retries: 0,
      createdAt: '2026-06-05T00:00:01.000Z',
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'qa_validation',
      type: 'ac-evidence',
      content: JSON.stringify({
        title: 'AC evidence',
        body: 'Only one criterion has current QA evidence.',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'QA validated AC-1.',
            gateResultIds: ['gate_test'],
          },
        ],
      }),
    });
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
      runId: 'run_1',
      nodeId: 'qa_validation',
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

    expect(result).toMatchObject({
      gateType: 'ac-evidence',
      status: 'failed',
      failureClassification: 'missing-ac-evidence',
    });
    expect(readFileSync(result.outputPath!, 'utf8')).toContain('AC-2');
    db.close();
  });

  it('rejects AC evidence without a real evidence anchor', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-ac-unanchored-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    await repositories.createNode({
      id: 'qa_validation',
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
        body: 'One acceptance criterion.',
        acceptanceCriteria: [{ id: 'AC-1', description: 'Criterion.' }],
      }),
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'qa_validation',
      type: 'ac-evidence',
      content: JSON.stringify({
        title: 'AC evidence',
        body: 'This only self-reports a pass.',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence:
              'QA says this passed, but links no artifact, gate, or output.',
          },
        ],
      }),
    });
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
      runId: 'run_1',
      nodeId: 'qa_validation',
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

    expect(result).toMatchObject({
      gateType: 'ac-evidence',
      status: 'failed',
      failureClassification: 'missing-evidence-anchor',
    });
    db.close();
  });

  it('requires QA signoff to cover every acceptance criterion', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-qa-partial-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await createRunFixture(repositories, repoPath);
    await audit.append({
      runId: 'run_1',
      type: 'qa.validation.ref',
      payload: { nodeId: 'qa_validation', ref: 'sha:cafebabe' },
    });
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
        body: 'Two acceptance criteria.',
        acceptanceCriteria: [
          { id: 'AC-1', description: 'First criterion.' },
          { id: 'AC-2', description: 'Second criterion.' },
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
      type: 'qa-release-signoff',
      content: JSON.stringify({
        title: 'QA release signoff',
        body: 'Only one acceptance criterion was validated.',
        targetRef: 'sha:cafebabe',
        validatedRef: 'sha:cafebabe',
        overallStatus: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Validated on sha:cafebabe.',
            gateResultIds: ['gate_test'],
          },
        ],
      }),
    });
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
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

    expect(result).toMatchObject({
      gateType: 'qa-signoff',
      status: 'failed',
      failureClassification: 'qa-signoff-ac-evidence',
    });
    expect(readFileSync(result.outputPath!, 'utf8')).toContain('AC-2');
    db.close();
  });

  it('rejects QA signoff without a real evidence anchor', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-qa-unanchored-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await createRunFixture(repositories, repoPath);
    await audit.append({
      runId: 'run_1',
      type: 'qa.validation.ref',
      payload: { nodeId: 'qa_validation', ref: 'sha:cafebabe' },
    });
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
        body: 'One acceptance criterion.',
        acceptanceCriteria: [{ id: 'AC-1', description: 'Criterion.' }],
      }),
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'qa_signoff',
      type: 'qa-release-signoff',
      content: JSON.stringify({
        title: 'QA release signoff',
        body: 'This only self-reports a pass.',
        targetRef: 'sha:cafebabe',
        validatedRef: 'sha:cafebabe',
        overallStatus: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence:
              'QA says this passed, but links no artifact, gate, or output.',
          },
        ],
      }),
    });
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
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

    expect(result).toMatchObject({
      gateType: 'qa-signoff',
      status: 'failed',
      failureClassification: 'missing-evidence-anchor',
    });
    db.close();
  });

  it('rejects QA signoff when no QA validation ref has been recorded', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-qa-no-ref-'));
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
        body: 'One acceptance criterion.',
        acceptanceCriteria: [{ id: 'AC-1', description: 'Criterion.' }],
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
      type: 'qa-release-signoff',
      content: JSON.stringify({
        title: 'QA release signoff',
        body: 'This lacks a tested ref anchor.',
        targetRef: 'sha:cafebabe',
        validatedRef: 'sha:cafebabe',
        overallStatus: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Validated on sha:cafebabe.',
            gateResultIds: ['gate_test'],
          },
        ],
      }),
    });
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
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

    expect(result).toMatchObject({
      gateType: 'qa-signoff',
      status: 'failed',
      failureClassification: 'missing-qa-validation-ref',
    });
    db.close();
  });

  it('rejects QA signoff when it does not match the recorded QA validation ref', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-qa-ref-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await createRunFixture(repositories, repoPath);
    await audit.append({
      runId: 'run_1',
      type: 'qa.validation.ref',
      payload: { nodeId: 'qa_validation', ref: 'sha:expected' },
    });
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
        body: 'One acceptance criterion.',
        acceptanceCriteria: [{ id: 'AC-1', description: 'Criterion.' }],
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
      type: 'qa-release-signoff',
      content: JSON.stringify({
        title: 'QA release signoff',
        body: 'This validates a stale ref.',
        targetRef: 'sha:stale',
        validatedRef: 'sha:stale',
        overallStatus: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Validated on sha:stale.',
            gateResultIds: ['gate_test'],
          },
        ],
      }),
    });
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
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

    expect(result).toMatchObject({
      gateType: 'qa-signoff',
      status: 'failed',
      failureClassification: 'qa-signoff-ref-mismatch',
    });
    db.close();
  });

  it('requires PMO process checkpoints to match prior workflow nodes', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-gate-pmo-process-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await createRunFixture(repositories, repoPath);
    await repositories.createNode({
      id: 'qa_validation',
      runId: 'run_1',
      role: 'qa',
      status: 'passed',
      gates: [],
      dependencies: ['node_1'],
      createdAt: '2026-06-05T00:00:01.000Z',
      updatedAt: '2026-06-05T00:00:02.000Z',
    });
    await repositories.createNode({
      id: 'pmo_checkpoint',
      runId: 'run_1',
      role: 'pmo',
      status: 'running',
      gates: [],
      dependencies: ['qa_validation'],
      createdAt: '2026-06-05T00:00:03.000Z',
      updatedAt: '2026-06-05T00:00:03.000Z',
    });
    const store = createArtifactStore({ repoPath, repositories });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'pmo_checkpoint',
      type: 'process-checkpoint',
      content: JSON.stringify({
        title: 'PMO checkpoint',
        body: 'Missing qa_validation in requiredNodes.',
        requiredNodes: [{ nodeId: 'node_1', status: 'passed' }],
        artifactEvidence: [],
        gateEvidence: [],
        humanDecisionEvidence: { pending: 0 },
        missingInformation: [],
      }),
    });
    const engine = createGateEngine({ repositories });

    const result = await engine.runGate({
      runId: 'run_1',
      nodeId: 'pmo_checkpoint',
      gate: {
        type: 'process-completeness',
        artifactType: 'process-checkpoint',
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
      gateType: 'process-completeness',
      status: 'failed',
      failureClassification: 'process-incomplete',
    });
    expect(readFileSync(result.outputPath!, 'utf8')).toContain('qa_validation');
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
