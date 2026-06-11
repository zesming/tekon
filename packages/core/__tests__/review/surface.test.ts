import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createArtifactStore,
  createAuditLogger,
  createPullRequestPreparation,
  createRepositories,
  createWorkReviewSurface,
  migrateDatabase,
  openTekonDatabase,
  writeDefaultRepoProfile,
} from '../../src/index.js';

describe('work review surface', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('collects readiness, artifact bodies, gate logs, PR package, and delivery diff', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-review-surface-'));
    tempDirs.push(repoPath);
    seedGitRepo(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeDefaultRepoProfile(repoPath);

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedPassedRun({ repoPath, repositories, audit });

    const gatesDir = join(repoPath, '.tekon', 'runs', 'run_1', 'gates');
    mkdirSync(gatesDir, { recursive: true });
    const testLogPath = join(gatesDir, 'node_1-test.log');
    const securityLogPath = join(gatesDir, 'node_1-security-scan.log');
    writeFileSync(testLogPath, 'test suite passed', 'utf8');
    writeFileSync(securityLogPath, '{"findings":[]}', 'utf8');

    await repositories.recordGateResult({
      id: 'gate_test',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'test',
      status: 'passed',
      outputPath: testLogPath,
      durationMs: 12,
      retries: 0,
      createdAt: '2026-06-08T00:00:02.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_security',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'security-scan',
      status: 'passed',
      outputPath: securityLogPath,
      durationMs: 4,
      retries: 0,
      createdAt: '2026-06-08T00:00:03.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_qa_signoff',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'qa-signoff',
      status: 'passed',
      durationMs: 3,
      retries: 0,
      createdAt: '2026-06-08T00:00:03.500Z',
    });
    await audit.append({
      runId: 'run_1',
      type: 'qa.validation.ref',
      payload: {
        nodeId: 'node_1',
        ref: 'branch:tekon-delivery/run_1',
      },
      createdAt: '2026-06-08T00:00:03.600Z',
    });

    const store = createArtifactStore({ repoPath, repositories });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'prd',
      content: JSON.stringify({
        title: 'PRD',
        body: 'Expose review surface.',
        acceptanceCriteria: [
          { id: 'AC-1', description: 'Reviewer can see evidence inline.' },
        ],
      }),
    });
    await store.writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'test-report',
      content: JSON.stringify({
        title: 'Tests',
        body: 'Review surface tests passed.',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Unit test covers inline review evidence.',
            gateResultIds: ['gate_test'],
          },
        ],
      }),
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
            gateResultIds: ['gate_qa_signoff'],
          },
        ],
      }),
    });
    await repositories.recordArtifact({
      id: 'artifact_outside',
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'review-report',
      version: 1,
      path: join(tmpdir(), 'tekon-review-outside.txt'),
      sha256: 'outside',
      sizeBytes: 7,
      summary: 'outside path must not be read',
      createdAt: '2026-06-08T00:00:04.000Z',
    });

    const preparation = await createPullRequestPreparation({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
    });
    await repositories.upsertDeliveryPullRequest({
      id: 'delivery_pr_1',
      runId: 'run_1',
      branch: preparation.branch,
      baseBranch: preparation.baseBranch,
      title: preparation.title,
      bodyPath: preparation.prBodyPath,
      status: 'created',
      prUrl: 'https://github.example/tekon/pull/1',
      approvedBy: 'tester',
      approvedAt: '2026-06-08T00:00:05.000Z',
      branchPushedAt: '2026-06-08T00:00:06.000Z',
      prCreatedAt: '2026-06-08T00:00:07.000Z',
      attemptCount: 1,
      createdAt: '2026-06-08T00:00:05.000Z',
      updatedAt: '2026-06-08T00:00:07.000Z',
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
        checkedAt: '2026-06-08T00:00:08.000Z',
        checks: [{ name: 'build', bucket: 'pass' }],
      }),
    });
    await audit.append({
      runId: 'run_1',
      type: 'delivery.ci.checked',
      payload: { artifactId: ciArtifact.id },
    });

    const surface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
      maxContentChars: 120,
    });

    expect(surface.readiness.ready).toBe(true);
    expect(surface.delivery.package?.content).toContain('PR Preparation');
    expect(surface.delivery.prBody?.content).toContain('Expose review surface');
    expect(surface.delivery.status).toBe('created');
    expect(surface.delivery.prUrl).toBe('https://github.example/tekon/pull/1');
    expect(surface.delivery.diff.available).toBe(true);
    expect(surface.delivery.diff.changedFiles).toContain('M\tfeature.txt');
    expect(surface.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'test-report',
          content: expect.objectContaining({
            exists: true,
            content: expect.stringContaining('Review surface tests passed'),
          }),
        }),
      ]),
    );
    expect(surface.artifacts).toContainEqual(
      expect.objectContaining({
        id: 'artifact_outside',
        content: expect.objectContaining({ exists: false, content: '' }),
      }),
    );
    expect(surface.gates).toContainEqual(
      expect.objectContaining({
        id: 'gate_test',
        output: expect.objectContaining({
          content: 'test suite passed',
        }),
      }),
    );
    expect(surface.gateFailureTriage).toEqual([]);
    expect(surface.evidenceGroups).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'review-route',
          links: expect.arrayContaining([
            expect.objectContaining({
              kind: 'pr-package',
              href: '#pr-package',
            }),
            expect.objectContaining({ kind: 'diff', href: '#delivery-diff' }),
          ]),
        }),
      ]),
    );
    expect(surface.evidenceGroups.map((group) => group.id)).not.toContain(
      'readiness-pr-created',
    );
    expect(surface.nextCommands).not.toContain(
      'tekon delivery create-pr --approve-human',
    );
    expect(surface.nextCommands).toEqual([
      'tekon status',
      'tekon eval readiness',
    ]);

    const explicitSurface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
      commandDisplay: 'explicit',
    });
    expect(explicitSurface.nextCommands).toEqual([
      `tekon status --run-id run_1 --repo ${repoPath}`,
      `tekon eval readiness --run-id run_1 --repo ${repoPath}`,
    ]);
    db.close();
  });

  it('does not recommend PR preparation for non standard-delivery runs', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-review-non-standard-'));
    tempDirs.push(repoPath);
    seedGitRepo(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeDefaultRepoProfile(repoPath);

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedPassedRun({
      repoPath,
      repositories,
      audit,
      templateId: 'standard-feature',
    });

    const surface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(surface.nextCommands).not.toContain('tekon delivery prepare');
    expect(surface.nextCommands).not.toContain(
      'tekon delivery create-pr --approve-human',
    );
    db.close();
  });

  it('triages failed gates with retry guidance and linked logs', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-review-triage-'));
    tempDirs.push(repoPath);
    seedGitRepo(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeDefaultRepoProfile(repoPath);

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedPassedRun({ repoPath, repositories, audit });

    const gatesDir = join(repoPath, '.tekon', 'runs', 'run_1', 'gates');
    mkdirSync(gatesDir, { recursive: true });
    const buildLogPath = join(gatesDir, 'node_1-build.log');
    const lintLogPath = join(gatesDir, 'node_1-lint.log');
    const approvalLogPath = join(gatesDir, 'node_1-test.log');
    const humanLogPath = join(gatesDir, 'node_1-human.log');
    const legacyHumanLogPath = join(gatesDir, 'node_1-legacy-human.log');
    const rejectedHumanLogPath = join(gatesDir, 'node_1-rejected-human.log');
    const securityLogPath = join(gatesDir, 'node_1-security-scan.log');
    writeFileSync(buildLogPath, 'build failed with TS error', 'utf8');
    writeFileSync(lintLogPath, 'missing command: lint', 'utf8');
    writeFileSync(
      approvalLogPath,
      'command blocked for approval: decision_1',
      'utf8',
    );
    writeFileSync(humanLogPath, 'human approval is required', 'utf8');
    writeFileSync(
      legacyHumanLogPath,
      'legacy human approval is required',
      'utf8',
    );
    writeFileSync(rejectedHumanLogPath, 'human rejected this gate', 'utf8');
    writeFileSync(
      securityLogPath,
      JSON.stringify({
        findings: [
          {
            id: 'finding_1',
            severity: 'critical',
            ruleId: 'openai-api-key',
          },
        ],
      }),
      'utf8',
    );
    await repositories.recordGateResult({
      id: 'gate_build',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'build',
      status: 'failed',
      outputPath: buildLogPath,
      durationMs: 12,
      retries: 0,
      failureClassification: 'exit-code',
      createdAt: '2026-06-08T00:00:02.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_lint',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'lint',
      status: 'failed',
      outputPath: lintLogPath,
      durationMs: 3,
      retries: 0,
      failureClassification: 'missing-command',
      createdAt: '2026-06-08T00:00:03.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_command_approval',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'test',
      status: 'blocked',
      outputPath: approvalLogPath,
      durationMs: 1,
      retries: 0,
      failureClassification: 'blocked-for-approval',
      createdAt: '2026-06-08T00:00:04.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_human',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'human',
      status: 'blocked',
      outputPath: humanLogPath,
      durationMs: 0,
      retries: 0,
      failureClassification: 'human-approval',
      createdAt: '2026-06-08T00:00:05.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_legacy_human',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'human',
      status: 'blocked',
      outputPath: legacyHumanLogPath,
      durationMs: 0,
      retries: 0,
      createdAt: '2026-06-08T00:00:06.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_rejected_human',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'human',
      status: 'failed',
      outputPath: rejectedHumanLogPath,
      durationMs: 0,
      retries: 0,
      failureClassification: 'human-rejected',
      createdAt: '2026-06-08T00:00:07.000Z',
    });
    await repositories.recordGateResult({
      id: 'gate_security',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'security-scan',
      status: 'failed',
      outputPath: securityLogPath,
      durationMs: 5,
      retries: 0,
      failureClassification: 'security-findings',
      createdAt: '2026-06-08T00:00:08.000Z',
    });

    const surface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
      maxContentChars: 120,
    });

    expect(surface.gateFailureTriage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: 'gate_build',
          classification: 'exit-code',
          retry: 'after-fix',
          logHref: '#gate-log-gate_build',
          suggestedCommand: 'tekon log',
        }),
        expect.objectContaining({
          gateId: 'gate_lint',
          classification: 'missing-command',
          retry: 'after-fix',
          suggestedCommand: 'tekon workflow preflight <template>',
        }),
        expect.objectContaining({
          gateId: 'gate_command_approval',
          classification: 'blocked-for-approval',
          retry: 'after-approval',
          summary: expect.stringContaining('Approve only after reviewing'),
          suggestedCommand: 'tekon resume --approve-human',
        }),
        expect.objectContaining({
          gateId: 'gate_human',
          classification: 'human-approval',
          retry: 'after-approval',
          suggestedCommand: 'tekon resume --approve-human',
        }),
        expect.objectContaining({
          gateId: 'gate_legacy_human',
          classification: 'human-approval',
          retry: 'after-approval',
          suggestedCommand: 'tekon resume --approve-human',
        }),
        expect.objectContaining({
          gateId: 'gate_rejected_human',
          classification: 'human-rejected',
          retry: 'not-recommended',
          summary: expect.stringContaining('human reviewer rejected'),
          suggestedCommand: 'tekon review',
        }),
        expect.objectContaining({
          gateId: 'gate_security',
          classification: 'security-findings',
          retry: 'after-fix',
          summary: expect.stringContaining('Security scan found'),
          suggestedCommand: 'tekon review',
        }),
      ]),
    );
    const explicitSurface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
      maxContentChars: 120,
      commandDisplay: 'explicit',
    });
    expect(explicitSurface.gateFailureTriage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          gateId: 'gate_build',
          suggestedCommand: `tekon log --run-id run_1 --repo ${repoPath}`,
        }),
        expect.objectContaining({
          gateId: 'gate_lint',
          suggestedCommand: `tekon workflow preflight <template> --repo ${repoPath}`,
        }),
        expect.objectContaining({
          gateId: 'gate_human',
          suggestedCommand: `tekon resume --run-id run_1 --approve-human --repo ${repoPath}`,
        }),
      ]),
    );
    db.close();
  });

  it('does not read symlinked or traversed repo paths for previews or readiness evidence', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-review-safe-'));
    const outsideDir = mkdtempSync(join(tmpdir(), 'tekon-review-outside-'));
    tempDirs.push(repoPath, outsideDir);
    seedGitRepo(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeDefaultRepoProfile(repoPath);

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedPassedRun({ repoPath, repositories, audit });
    await seedPassedValidationGates({ repoPath, repositories });

    const outsideArtifactPath = join(outsideDir, 'outside-artifact.json');
    writeFileSync(
      outsideArtifactPath,
      JSON.stringify({
        title: 'Outside',
        body: 'This evidence must not be read.',
        acceptanceCriteria: [
          { id: 'AC-OUT', description: 'Outside criterion.' },
        ],
        criteriaEvidence: [
          {
            criterionId: 'AC-OUT',
            status: 'passed',
            evidence: 'Outside evidence.',
            gateResultIds: ['gate_test'],
          },
        ],
      }),
      'utf8',
    );

    const artifactsDir = join(
      repoPath,
      '.tekon',
      'runs',
      'run_1',
      'artifacts',
      'node_1',
    );
    mkdirSync(artifactsDir, { recursive: true });
    const symlinkArtifactPath = join(artifactsDir, 'symlink-report.v1.md');
    symlinkSync(outsideArtifactPath, symlinkArtifactPath);
    await repositories.recordArtifact({
      id: 'artifact_symlink',
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'test-report',
      version: 1,
      path: '.tekon/runs/run_1/artifacts/node_1/symlink-report.v1.md',
      sha256: 'symlink',
      sizeBytes: 10,
      summary: 'symlink must not be read',
      createdAt: '2026-06-08T00:00:04.000Z',
    });
    await repositories.recordArtifact({
      id: 'artifact_traversal',
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'prd',
      version: 1,
      path: relative(repoPath, outsideArtifactPath),
      sha256: 'traversal',
      sizeBytes: 10,
      summary: 'traversal must not be read',
      createdAt: '2026-06-08T00:00:05.000Z',
    });
    await repositories.recordArtifact({
      id: 'artifact_delivery',
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'delivery-package',
      version: 1,
      path: '.tekon/runs/run_1/artifacts/node_1/delivery-package.v1.md',
      sha256: 'delivery',
      sizeBytes: 1,
      summary: 'delivery package marker',
      createdAt: '2026-06-08T00:00:06.000Z',
    });
    await audit.append({
      runId: 'run_1',
      type: 'delivery.pr-prepared',
      payload: { branch: 'tekon-delivery/run_1' },
      createdAt: '2026-06-08T00:00:07.000Z',
    });

    const outsideGatePath = join(outsideDir, 'outside-gate.log');
    writeFileSync(outsideGatePath, 'secret gate output', 'utf8');
    const gatesDir = join(repoPath, '.tekon', 'runs', 'run_1', 'gates');
    mkdirSync(gatesDir, { recursive: true });
    const symlinkGatePath = join(gatesDir, 'symlink-gate.log');
    symlinkSync(outsideGatePath, symlinkGatePath);
    await repositories.recordGateResult({
      id: 'gate_symlink',
      runId: 'run_1',
      nodeId: 'node_1',
      gateType: 'human',
      status: 'blocked',
      outputPath: symlinkGatePath,
      durationMs: 0,
      retries: 0,
      createdAt: '2026-06-08T00:00:08.000Z',
    });

    const surface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(surface.readiness.ready).toBe(false);
    expect(surface.readiness.checks).toContainEqual(
      expect.objectContaining({
        id: 'acceptance-criteria-evidenced',
        passed: false,
      }),
    );
    expect(surface.artifacts).toContainEqual(
      expect.objectContaining({
        id: 'artifact_symlink',
        content: expect.objectContaining({ exists: false, content: '' }),
      }),
    );
    expect(surface.artifacts).toContainEqual(
      expect.objectContaining({
        id: 'artifact_traversal',
        content: expect.objectContaining({ exists: false, content: '' }),
      }),
    );
    expect(surface.gates).toContainEqual(
      expect.objectContaining({
        id: 'gate_symlink',
        output: expect.objectContaining({ exists: false, content: '' }),
      }),
    );
    db.close();
  });

  it('does not let a stored project repo path widen review readiness evidence reads', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-review-boundary-'));
    const outsideRepoPath = mkdtempSync(
      join(tmpdir(), 'tekon-review-boundary-outside-'),
    );
    tempDirs.push(repoPath, outsideRepoPath);
    seedGitRepo(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeDefaultRepoProfile(repoPath);

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedPassedRun({ repoPath: outsideRepoPath, repositories, audit });
    await seedPassedValidationGates({ repoPath, repositories });

    const outsideArtifactPath = join(outsideRepoPath, 'passed-evidence.json');
    writeFileSync(
      outsideArtifactPath,
      JSON.stringify({
        title: 'Outside evidence',
        body: 'This would make readiness pass if project repoPath was trusted.',
        acceptanceCriteria: [
          { id: 'AC-OUT', description: 'Outside criterion.' },
        ],
        criteriaEvidence: [
          {
            criterionId: 'AC-OUT',
            status: 'passed',
            evidence: 'Outside evidence.',
            gateResultIds: ['gate_test'],
          },
        ],
      }),
      'utf8',
    );
    await repositories.recordArtifact({
      id: 'artifact_outside_passed',
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'test-report',
      version: 1,
      path: outsideArtifactPath,
      sha256: 'outside',
      sizeBytes: 10,
      summary: 'outside evidence must not be used by review readiness',
      createdAt: '2026-06-08T00:00:04.000Z',
    });
    await repositories.recordArtifact({
      id: 'artifact_delivery',
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'delivery-package',
      version: 1,
      path: '.tekon/runs/run_1/artifacts/node_1/delivery-package.v1.md',
      sha256: 'delivery',
      sizeBytes: 1,
      summary: 'delivery package marker',
      createdAt: '2026-06-08T00:00:05.000Z',
    });
    await audit.append({
      runId: 'run_1',
      type: 'delivery.pr-prepared',
      payload: { branch: 'tekon-delivery/run_1' },
      createdAt: '2026-06-08T00:00:06.000Z',
    });

    const surface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
    });

    expect(surface.readiness.ready).toBe(false);
    expect(surface.readiness.checks).toContainEqual(
      expect.objectContaining({
        id: 'acceptance-criteria-evidenced',
        passed: false,
        evidence: '0/0 acceptance criteria evidenced',
      }),
    );
    expect(surface.artifacts).toContainEqual(
      expect.objectContaining({
        id: 'artifact_outside_passed',
        content: expect.objectContaining({ exists: false, content: '' }),
      }),
    );
    db.close();
  });

  it('marks delivery diff unavailable for unsafe refs and missing base refs', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-review-diff-'));
    tempDirs.push(repoPath);
    seedGitRepo(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeDefaultRepoProfile(repoPath);

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedPassedRun({ repoPath, repositories, audit });

    await repositories.upsertDeliveryPullRequest({
      id: 'delivery_pr_1',
      runId: 'run_1',
      branch: '--bad-ref',
      baseBranch: 'main',
      title: 'Unsafe branch',
      status: 'prepared',
      attemptCount: 0,
      createdAt: '2026-06-08T00:00:01.000Z',
      updatedAt: '2026-06-08T00:00:01.000Z',
    });
    const unsafeBranchSurface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
    });
    expect(unsafeBranchSurface.delivery.diff).toMatchObject({
      available: false,
      reason: 'branch ref is missing or unsafe: --bad-ref',
    });

    await repositories.upsertDeliveryPullRequest({
      id: 'delivery_pr_1',
      runId: 'run_1',
      branch: 'tekon-delivery/run_1',
      baseBranch: 'HEAD@{1}',
      title: 'Unsafe base',
      status: 'prepared',
      attemptCount: 0,
      createdAt: '2026-06-08T00:00:01.000Z',
      updatedAt: '2026-06-08T00:00:02.000Z',
    });
    const unsafeBaseSurface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
    });
    expect(unsafeBaseSurface.delivery.diff).toMatchObject({
      available: false,
      reason: 'base ref is missing or unsafe: HEAD@{1}',
    });

    await repositories.upsertDeliveryPullRequest({
      id: 'delivery_pr_1',
      runId: 'run_1',
      branch: 'tekon-delivery/run_1',
      baseBranch: 'missing-base',
      title: 'Missing base',
      status: 'prepared',
      attemptCount: 0,
      createdAt: '2026-06-08T00:00:01.000Z',
      updatedAt: '2026-06-08T00:00:02.000Z',
    });
    const missingBaseSurface = await createWorkReviewSurface({
      repoPath,
      repositories,
      audit,
      runId: 'run_1',
    });
    expect(missingBaseSurface.delivery.diff).toMatchObject({
      available: false,
      reason: 'base ref is missing or unsafe: missing-base',
    });
    db.close();
  });
});

function seedGitRepo(repoPath: string) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({ scripts: { test: 'node -e "process.exit(0)"' } }),
    'utf8',
  );
  writeFileSync(join(repoPath, 'feature.txt'), 'before\n', 'utf8');
  execFileSync('git', ['add', 'package.json', 'feature.txt'], {
    cwd: repoPath,
  });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'tekon-delivery/run_1'], {
    cwd: repoPath,
  });
  writeFileSync(join(repoPath, 'feature.txt'), 'after\n', 'utf8');
  execFileSync('git', ['add', 'feature.txt'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'change'], { cwd: repoPath });
  execFileSync('git', ['checkout', 'main'], { cwd: repoPath });
}

async function seedPassedRun(input: {
  repoPath: string;
  repositories: ReturnType<typeof createRepositories>;
  audit: ReturnType<typeof createAuditLogger>;
  templateId?: string;
}) {
  await input.repositories.createDemand({
    id: 'demand_1',
    title: 'Expose review surface',
    body: 'Show artifacts, gates, readiness, PR body, and diff inline.',
    createdAt: '2026-06-08T00:00:00.000Z',
  });
  await input.repositories.createProject({
    id: 'project_1',
    name: 'fixture',
    repoPath: input.repoPath,
    createdAt: '2026-06-08T00:00:00.000Z',
  });
  await input.repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'passed',
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:01.000Z',
  });
  await input.audit.append({
    runId: 'run_1',
    type: 'run.started',
    payload: {
      templateId: input.templateId ?? 'standard-delivery',
      mode: 'template',
    },
    createdAt: '2026-06-08T00:00:00.100Z',
  });
  await input.repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    role: 'pmo',
    status: 'passed',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:01.000Z',
  });
  for (const [index, gateType] of [
    'independent-review',
    'role-scope',
    'ac-evidence',
    'process-completeness',
  ].entries()) {
    await input.repositories.recordGateResult({
      id: `gate_governance_${gateType}`,
      runId: 'run_1',
      nodeId: 'node_1',
      gateType,
      status: 'passed',
      durationMs: 1,
      retries: 0,
      createdAt: `2026-06-08T00:00:01.${100 + index}Z`,
    });
  }
}

async function seedPassedValidationGates(input: {
  repoPath: string;
  repositories: ReturnType<typeof createRepositories>;
}) {
  const gatesDir = join(input.repoPath, '.tekon', 'runs', 'run_1', 'gates');
  mkdirSync(gatesDir, { recursive: true });
  const testLogPath = join(gatesDir, 'node_1-test.log');
  const securityLogPath = join(gatesDir, 'node_1-security-scan.log');
  writeFileSync(testLogPath, 'test suite passed', 'utf8');
  writeFileSync(securityLogPath, '{"findings":[]}', 'utf8');
  await input.repositories.recordGateResult({
    id: 'gate_test',
    runId: 'run_1',
    nodeId: 'node_1',
    gateType: 'test',
    status: 'passed',
    outputPath: testLogPath,
    durationMs: 12,
    retries: 0,
    createdAt: '2026-06-08T00:00:02.000Z',
  });
  await input.repositories.recordGateResult({
    id: 'gate_security',
    runId: 'run_1',
    nodeId: 'node_1',
    gateType: 'security-scan',
    status: 'passed',
    outputPath: securityLogPath,
    durationMs: 4,
    retries: 0,
    createdAt: '2026-06-08T00:00:03.000Z',
  });
}
