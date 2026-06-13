import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  assertPrePullRequestReady,
  createAuditLogger,
  createRepositories,
  evaluatePrePullRequestReadiness,
  migrateDatabase,
  openTekonDatabase,
} from '../../src/index.js';
import type { AuditLogger, GateResult, TekonRepositories } from '../../src/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let db: ReturnType<typeof openTekonDatabase>;
let repos: TekonRepositories;
let audit: AuditLogger;
let repoPath: string;
/** IDs of gates created during fixture setup so artifacts can reference them. */
let gateIds: string[];

function setupDb() {
  db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  repos = createRepositories(db);
  audit = createAuditLogger({ repositories: repos });
  gateIds = [];
}

function cleanupDb() {
  db.close();
}

function setupRepoDir() {
  repoPath = mkdtempSync(join(tmpdir(), 'tekon-readiness-'));
}

function cleanupRepoDir() {
  rmSync(repoPath, { recursive: true, force: true });
}

async function createBaseFixtures(overrides?: {
  workflowStatus?: string;
  templateId?: string;
}) {
  await repos.createDemand({
    id: 'demand_1',
    title: 'Test demand',
    body: 'Body of test demand.',
    createdAt: '2026-06-13T00:00:00.000Z',
  });
  await repos.createProject({
    id: 'project_1',
    name: 'tekon',
    repoPath,
    createdAt: '2026-06-13T00:00:00.000Z',
  });
  await repos.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: overrides?.workflowStatus ?? 'passed',
    currentNodeId: 'node_1',
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
  });
  await repos.createNode({
    id: 'node_1',
    runId: 'run_1',
    role: 'rd',
    status: 'passed',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-13T00:00:00.000Z',
    updatedAt: '2026-06-13T00:00:00.000Z',
  });

  // Audit events -- at least one for hash chain; run.started for template detection
  await audit.append({
    runId: 'run_1',
    type: 'run.started',
    payload: { templateId: overrides?.templateId ?? 'standard-delivery' },
    createdAt: '2026-06-13T00:00:00.000Z',
  });
  await audit.append({
    runId: 'run_1',
    type: 'workflow.completed',
    payload: { status: 'passed' },
    createdAt: '2026-06-13T00:00:01.000Z',
  });
}

interface GateInput {
  nodeId?: string;
  gateType: string;
  gateKey?: string | null;
  status: string;
  failureClassification?: string | null;
  createdAt?: string;
}
async function addGate(input: GateInput): Promise<GateResult> {
  const gate = await repos.recordGateResult({
    id: `gate_${input.gateType}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    runId: 'run_1',
    nodeId: input.nodeId ?? 'node_1',
    gateType: input.gateType,
    gateKey: input.gateKey ?? null,
    status: input.status as never,
    outputPath: null,
    durationMs: 100,
    retries: 0,
    fixAttemptId: null,
    failureClassification: input.failureClassification ?? null,
    createdAt: input.createdAt ?? '2026-06-13T00:00:02.000Z',
  });
  gateIds.push(gate.id);
  return gate;
}

async function addHumanDecision(overrides?: {
  status?: string;
}) {
  return repos.createHumanDecision({
    id: `hd_${Math.random().toString(36).slice(2, 6)}`,
    runId: 'run_1',
    nodeId: 'node_1',
    gateResultId: null,
    status: (overrides?.status ?? 'approved') as 'pending' | 'approved' | 'rejected',
    actor: 'test-user',
    note: null,
    createdAt: '2026-06-13T00:00:00.000Z',
    decidedAt: '2026-06-13T00:00:01.000Z',
    gateType: '',
  });
}

interface ArtifactInput {
  type: string;
  path: string;
  nodeId?: string;
}
async function addArtifact(input: ArtifactInput) {
  return repos.recordArtifact({
    id: `artifact_${input.type}_${Math.random().toString(36).slice(2, 6)}`,
    type: input.type as never,
    version: 1,
    path: input.path,
    sha256: 'abc123',
    runId: 'run_1',
    nodeId: input.nodeId ?? 'node_1',
    sizeBytes: 100,
    summary: '',
    createdAt: '2026-06-13T00:00:00.000Z',
  });
}

function writeRepoFile(relPath: string, content: string) {
  const fullPath = join(repoPath, relPath);
  mkdirSync(join(fullPath, '..'), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

/**
 * Create the minimal evidence artifacts that make acceptance-evidenced,
 * qa-release-signoff-passed, and security-scans-passed checks pass.
 *
 * Pre-condition: validation gates (build, test, lint, e2e-pass) and
 * security-scan gate must already exist and gateIds array populated.
 */
async function seedEvidenceArtifacts() {
  // Artifact 1: demand-card – registers acceptance criteria
  await addArtifact({ type: 'demand-card', path: 'artifacts/demand-card/v1/demand.json' });
  writeRepoFile('artifacts/demand-card/v1/demand.json', JSON.stringify({
    title: 'Test Demand',
    body: 'Demand body for testing.',
    acceptanceCriteria: [
      { id: 'ac_1', description: 'Acceptance criterion 1' },
    ],
  }));

  // Artifact 2: test-report – provides criteriaEvidence that references a passed gate.
  // The first gate in gateIds should be a passed validation gate (build).
  const passedGateId = gateIds[0];
  await addArtifact({ type: 'test-report', path: 'artifacts/test-report/v1/report.json' });
  writeRepoFile('artifacts/test-report/v1/report.json', JSON.stringify({
    title: 'Test Report',
    body: 'All tests passed.',
    criteriaEvidence: [
      {
        criterionId: 'ac_1',
        status: 'passed',
        evidence: 'Criteria met.',
        gateResultIds: [passedGateId],
      },
    ],
  }));

  // Artifact 3: qa-release-signoff – enables qa-release-signoff-passed check
  await addArtifact({ type: 'qa-release-signoff', path: 'artifacts/qa-release-signoff/v1/signoff.json' });
  writeRepoFile('artifacts/qa-release-signoff/v1/signoff.json', JSON.stringify({
    title: 'QA Signoff',
    body: 'QA signoff body.',
    criteriaEvidence: [
      { criterionId: 'ac_1', status: 'passed', evidence: 'QA verified.' },
    ],
    targetRef: 'main',
    validatedRef: 'main',
    overallStatus: 'passed',
  }));

  // QA validation ref audit event (sets expectedRef for signoff match)
  await audit.append({
    runId: 'run_1',
    type: 'qa.validation.ref',
    payload: { ref: 'main' },
    createdAt: '2026-06-13T00:00:30.000Z',
  });
}

// ---------------------------------------------------------------------------
// Happy-path fixture: all checks pass
// ---------------------------------------------------------------------------

async function seedHappyPathFixtures() {
  await createBaseFixtures();

  // Validation gates – all passed (build first, so gateIds[0] is available for evidence)
  for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
    await addGate({ gateType, status: 'passed', createdAt: '2026-06-13T00:00:10.000Z' });
  }

  // Governance gates – all passed
  for (const gateType of [
    'independent-review',
    'role-scope',
    'ac-evidence',
    'qa-signoff',
    'process-completeness',
  ]) {
    await addGate({ gateType, status: 'passed', createdAt: '2026-06-13T00:00:20.000Z' });
  }

  // Security scan gate – passed
  await addGate({ gateType: 'security-scan', status: 'passed', createdAt: '2026-06-13T00:00:25.000Z' });

  // Evidence artifacts (uses gateIds[0] for criteriaEvidence reference)
  await seedEvidenceArtifacts();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluatePrePullRequestReadiness', () => {
  beforeEach(() => {
    setupDb();
    setupRepoDir();
  });

  afterEach(() => {
    cleanupDb();
    cleanupRepoDir();
  });

  it('returns ready=true when all checks pass (happy path)', async () => {
    await seedHappyPathFixtures();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos,
      audit,
      runId: 'run_1',
      repoPath,
    });

    expect(result.runId).toBe('run_1');
    expect(result.ready).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(8);

    for (const check of result.checks) {
      expect(check.passed, `check "${check.id}" should pass`).toBe(true);
    }
  });

  it('throws when workflow run does not exist', async () => {
    await expect(
      evaluatePrePullRequestReadiness({
        repositories: repos,
        audit,
        runId: 'nonexistent',
        repoPath,
      }),
    ).rejects.toThrow('run not found: nonexistent');
  });

  it('fails standard-delivery-template check when template is not standard-delivery', async () => {
    await createBaseFixtures({ templateId: 'custom-template' });
    // Validation gates
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    // Governance gates
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const templateCheck = result.checks.find((c) => c.id === 'standard-delivery-template');
    expect(templateCheck).toBeDefined();
    expect(templateCheck!.passed).toBe(false);
    expect(templateCheck!.evidence).toContain('custom-template');
  });

  it('fails workflow-passed check when workflow status is not passed', async () => {
    await createBaseFixtures({ workflowStatus: 'failed' });
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const workflowCheck = result.checks.find((c) => c.id === 'workflow-passed');
    expect(workflowCheck).toBeDefined();
    expect(workflowCheck!.passed).toBe(false);
    expect(workflowCheck!.evidence).toContain('failed');
  });

  it('fails audit-valid check when audit hash chain is tampered', async () => {
    await seedHappyPathFixtures();
    // Tamper with an audit event
    const events = await repos.listAuditEvents('run_1');
    const lastEvent = events.at(-1);
    expect(lastEvent).toBeDefined();
    db.prepare('update audit_events set payload = ? where id = ?').run(
      JSON.stringify({ tampered: true }),
      lastEvent!.id,
    );

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const auditCheck = result.checks.find((c) => c.id === 'audit-valid');
    expect(auditCheck).toBeDefined();
    expect(auditCheck!.passed).toBe(false);
    expect(auditCheck!.evidence).toContain('broken');
  });

  it('fails validation-gates-passed check when a validation gate fails', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'e2e-pass', status: 'failed' });
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const vgCheck = result.checks.find((c) => c.id === 'validation-gates-passed');
    expect(vgCheck).toBeDefined();
    expect(vgCheck!.passed).toBe(false);
    expect(vgCheck!.evidence).toContain('3/4');
  });

  it('fails no-pending-human-gates check when a human decision is pending', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await addHumanDecision({ status: 'pending' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const pendingCheck = result.checks.find((c) => c.id === 'no-pending-human-gates');
    expect(pendingCheck).toBeDefined();
    expect(pendingCheck!.passed).toBe(false);
    expect(pendingCheck!.evidence).toContain('1 pending');
  });

  it('fails standard-governance-gates-passed when a governance gate is missing', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    // Only add some governance gates, miss 'process-completeness' and 'role-scope'
    for (const gateType of ['independent-review', 'ac-evidence', 'qa-signoff']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const govCheck = result.checks.find((c) => c.id === 'standard-governance-gates-passed');
    expect(govCheck).toBeDefined();
    expect(govCheck!.passed).toBe(false);
    expect(govCheck!.evidence).toMatch(/process-completeness|role-scope/);
  });
});

describe('assertPrePullRequestReady', () => {
  beforeEach(() => {
    setupDb();
    setupRepoDir();
  });

  afterEach(() => {
    cleanupDb();
    cleanupRepoDir();
  });

  it('returns readiness object when all checks pass', async () => {
    await seedHappyPathFixtures();

    const result = await assertPrePullRequestReady({
      repositories: repos,
      audit,
      runId: 'run_1',
      repoPath,
    });

    expect(result.ready).toBe(true);
    expect(result.checks.length).toBeGreaterThanOrEqual(8);
  });

  it('throws with descriptive message when not ready', async () => {
    await createBaseFixtures({ workflowStatus: 'failed' });
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    await expect(
      assertPrePullRequestReady({
        repositories: repos,
        audit,
        runId: 'run_1',
        repoPath,
      }),
    ).rejects.toThrow(/run is not ready for PR creation/);
  });
});

describe('isSatisfiedValidationGate logic (via evaluatePrePullRequestReadiness)', () => {
  beforeEach(() => {
    setupDb();
    setupRepoDir();
  });

  afterEach(() => {
    cleanupDb();
    cleanupRepoDir();
  });

  it('treats passed gate as satisfied', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });
    expect(result.ready).toBe(true);
  });

  it('treats skipped gate with not-applicable classification as satisfied', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    // e2e-pass skipped as not-applicable → still satisfied
    await addGate({ gateType: 'e2e-pass', status: 'skipped', failureClassification: 'not-applicable' });
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });
    expect(result.ready).toBe(true);
  });

  it('treats skipped gate without not-applicable classification as NOT satisfied', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'e2e-pass', status: 'skipped', failureClassification: null });
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const vgCheck = result.checks.find((c) => c.id === 'validation-gates-passed');
    expect(vgCheck).toBeDefined();
    expect(vgCheck!.passed).toBe(false);
    expect(vgCheck!.evidence).toContain('3/4');
  });

  it('treats failed gate as NOT satisfied', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'e2e-pass', status: 'failed' });
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
  });
});

describe('latestGateResults deduplication (via evaluatePrePullRequestReadiness)', () => {
  beforeEach(() => {
    setupDb();
    setupRepoDir();
  });

  afterEach(() => {
    cleanupDb();
    cleanupRepoDir();
  });

  it('keeps only the latest gate result per node + type', async () => {
    await createBaseFixtures();
    // Earlier failed build, later passed build for same node → latest (passed) wins
    await addGate({ gateType: 'build', status: 'failed', createdAt: '2026-06-13T00:00:01.000Z' });
    await addGate({ gateType: 'build', status: 'passed', createdAt: '2026-06-13T00:00:02.000Z' });
    // Other validation gates passed
    for (const gateType of ['test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    // The latest build gate is passed, so all validation gates satisfied
    expect(result.ready).toBe(true);
    const vgCheck = result.checks.find((c) => c.id === 'validation-gates-passed');
    expect(vgCheck!.evidence).toBe('4/4 validation gates passed or explicitly skipped');
  });

  it('uses gateKey for deduplication key when present', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    // Duplicate ac-evidence for same node but different gateKey → separate entries, both passed
    await addGate({ gateType: 'ac-evidence', status: 'passed', gateKey: 'key-a', createdAt: '2026-06-13T00:00:01.000Z' });
    await addGate({ gateType: 'ac-evidence', status: 'passed', gateKey: 'key-b', createdAt: '2026-06-13T00:00:02.000Z' });
    for (const gateType of ['independent-review', 'role-scope', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });
    expect(result.ready).toBe(true);
  });

  it('governance gate later failure overrides earlier pass on same node+type', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    // Earlier passed process-completeness, later failed on same node → latest (failed) wins
    await addGate({ gateType: 'process-completeness', status: 'passed', createdAt: '2026-06-13T00:00:01.000Z' });
    await addGate({ gateType: 'process-completeness', status: 'failed', createdAt: '2026-06-13T00:00:02.000Z' });
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const govCheck = result.checks.find((c) => c.id === 'standard-governance-gates-passed');
    expect(govCheck!.passed).toBe(false);
    expect(govCheck!.evidence).toContain('process-completeness');
  });
});

describe('qaSignoffCheck and governanceGatesCheck logic (via evaluatePrePullRequestReadiness)', () => {
  beforeEach(() => {
    setupDb();
    setupRepoDir();
  });

  afterEach(() => {
    cleanupDb();
    cleanupRepoDir();
  });

  it('qa-release-signoff-passed fails when qa-signoff gate is not passed', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    // Governance gates all passed except qa-signoff
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    // qa-signoff gate failed
    await addGate({ gateType: 'qa-signoff', status: 'failed' });
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const qaCheck = result.checks.find((c) => c.id === 'qa-release-signoff-passed');
    expect(qaCheck).toBeDefined();
    expect(qaCheck!.passed).toBe(false);
  });

  it('qa-release-signoff-passed fails when no matching qa signoff artifact exists', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff', 'process-completeness']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    // Only demand-card + test-report, NO qa-release-signoff artifact
    const passedGateId = gateIds[0];
    await addArtifact({ type: 'demand-card', path: 'artifacts/demand-card/v1/demand.json' });
    writeRepoFile('artifacts/demand-card/v1/demand.json', JSON.stringify({
      title: 'Demand', body: 'Body',
      acceptanceCriteria: [{ id: 'ac_1', description: 'AC 1' }],
    }));
    await addArtifact({ type: 'test-report', path: 'artifacts/test-report/v1/report.json' });
    writeRepoFile('artifacts/test-report/v1/report.json', JSON.stringify({
      title: 'Test Report', body: 'Report',
      criteriaEvidence: [
        { criterionId: 'ac_1', status: 'passed', evidence: 'OK.', gateResultIds: [passedGateId] },
      ],
    }));

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const qaCheck = result.checks.find((c) => c.id === 'qa-release-signoff-passed');
    expect(qaCheck).toBeDefined();
    expect(qaCheck!.passed).toBe(false);
    expect(qaCheck!.evidence).toBe('QA release signoff missing');
  });

  it('governance check identifies exactly which required gate types are missing', async () => {
    await createBaseFixtures();
    for (const gateType of ['build', 'test', 'lint', 'e2e-pass']) {
      await addGate({ gateType, status: 'passed' });
    }
    // Only pass some governance gates; deliberately omit process-completeness
    for (const gateType of ['independent-review', 'role-scope', 'ac-evidence', 'qa-signoff']) {
      await addGate({ gateType, status: 'passed' });
    }
    await addGate({ gateType: 'security-scan', status: 'passed' });
    await seedEvidenceArtifacts();

    const result = await evaluatePrePullRequestReadiness({
      repositories: repos, audit, runId: 'run_1', repoPath,
    });

    expect(result.ready).toBe(false);
    const govCheck = result.checks.find((c) => c.id === 'standard-governance-gates-passed');
    expect(govCheck!.passed).toBe(false);
    expect(govCheck!.evidence).toContain('process-completeness');
  });
});
