import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createArtifactStore,
  createDeliveryEvidencePackage,
  createRepositories,
  evaluateWorkReadiness,
  migrateDatabase,
  openTekonDatabase,
  queryPullRequestCiStatus,
  watchPullRequestCiStatus,
  type CommandGateway,
  type CommandGatewayRunInput,
} from '../../src/index.js';

describe('delivery CI status', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('queries PR checks, writes a ci-status artifact, and updates delivery evidence', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-ci-status-'));
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-ci-output-'));
    tempDirs.push(repoPath, outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedCiRun({ repositories, repoPath });

    const stdoutPath = join(outputDir, 'checks.json');
    writeFileSync(
      stdoutPath,
      JSON.stringify([
        {
          name: 'build',
          bucket: 'pass',
          state: 'SUCCESS',
          workflow: 'CI',
          link: 'https://github.example/org/repo/actions/runs/1',
        },
        {
          name: 'test',
          bucket: 'pass',
          state: 'SUCCESS',
          workflow: 'CI',
        },
      ]),
      'utf8',
    );
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        return {
          status: 'executed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath,
          stderrPath: join(outputDir, 'checks.err'),
          durationMs: 1,
        };
      },
    };

    const report = await queryPullRequestCiStatus({
      repoPath,
      runId: 'run_1',
      repositories,
      audit,
      gateway,
    });

    expect(report).toMatchObject({
      status: 'passed',
      selector: 'https://github.example/org/repo/pull/7',
      checks: expect.arrayContaining([
        expect.objectContaining({ name: 'build', bucket: 'pass' }),
      ]),
      artifact: expect.objectContaining({ type: 'ci-status' }),
    });
    expect(calls[0]).toMatchObject({
      command: {
        tool: 'gh',
        args: [
          'pr',
          'checks',
          'https://github.example/org/repo/pull/7',
          '--json',
          'bucket,completedAt,description,event,link,name,startedAt,state,workflow',
        ],
      },
      cwd: repoPath,
      policy: expect.objectContaining({ network: 'enabled' }),
    });

    const evidence = await createDeliveryEvidencePackage({
      repositories,
      audit,
      runId: 'run_1',
      repoPath,
    });
    expect(evidence.ciStatuses).toEqual([
      expect.objectContaining({
        artifactId: report.artifact.id,
        status: 'passed',
        checks: 2,
        prUrl: 'https://github.example/org/repo/pull/7',
      }),
    ]);
    const readiness = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
      repoPath,
    });
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: 'remote-ci-passed',
        severity: 'recommended',
        passed: true,
      }),
    );
    expect(await repositories.listAuditEvents('run_1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delivery.ci.checked' }),
      ]),
    );
    db.close();
  });

  it('summarizes failing PR checks without requiring remote side effects', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-ci-fail-'));
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-ci-fail-output-'));
    tempDirs.push(repoPath, outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedCiRun({ repositories, repoPath });
    const stdoutPath = join(outputDir, 'checks.json');
    writeFileSync(
      stdoutPath,
      JSON.stringify([{ name: 'e2e', bucket: 'fail', state: 'FAILURE' }]),
      'utf8',
    );

    const report = await queryPullRequestCiStatus({
      repoPath,
      runId: 'run_1',
      repositories,
      gateway: {
        async run() {
          return {
            status: 'executed',
            exitCode: 1,
            signal: null,
            timedOut: false,
            stdoutPath,
            stderrPath: join(outputDir, 'checks.err'),
            durationMs: 1,
          };
        },
      },
    });

    expect(report.status).toBe('failed');
    db.close();
  });

  it('uses only the latest CI status as delivery and readiness evidence', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-ci-latest-'));
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-ci-latest-output-'));
    tempDirs.push(repoPath, outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedCiRun({ repositories, repoPath });
    const stdoutPath = join(outputDir, 'checks.json');
    const gateway: CommandGateway = {
      async run() {
        return {
          status: 'executed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath,
          stderrPath: join(outputDir, 'checks.err'),
          durationMs: 1,
        };
      },
    };

    writeFileSync(
      stdoutPath,
      JSON.stringify([{ name: 'build', bucket: 'pass', state: 'SUCCESS' }]),
      'utf8',
    );
    await queryPullRequestCiStatus({
      repoPath,
      runId: 'run_1',
      repositories,
      audit,
      gateway,
    });
    writeFileSync(
      stdoutPath,
      JSON.stringify([{ name: 'build', bucket: 'fail', state: 'FAILURE' }]),
      'utf8',
    );
    const latestReport = await queryPullRequestCiStatus({
      repoPath,
      runId: 'run_1',
      repositories,
      audit,
      gateway,
    });

    const evidence = await createDeliveryEvidencePackage({
      repositories,
      audit,
      runId: 'run_1',
      repoPath,
    });
    expect(evidence.ciStatuses).toEqual([
      expect.objectContaining({
        artifactId: latestReport.artifact.id,
        status: 'failed',
      }),
    ]);
    const readiness = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
      repoPath,
    });
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: 'remote-ci-passed',
        passed: false,
        evidence: expect.stringContaining('failed checks=1'),
      }),
    );
    db.close();
  });

  it('does not trust unaudited ci-status artifacts as remote CI evidence', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-ci-forged-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedCiRun({ repositories, repoPath });

    await createArtifactStore({ repoPath, repositories }).writeArtifact({
      runId: 'run_1',
      nodeId: 'node_1',
      type: 'ci-status',
      content: JSON.stringify(
        {
          title: 'Forged CI',
          body: 'This did not come from gh pr checks.',
          ciStatus: 'passed',
          checkedAt: '2026-06-08T00:00:00.000Z',
          checks: [{ name: 'forged', bucket: 'pass' }],
        },
        null,
        2,
      ),
      summary: 'forged CI status',
    });

    const evidence = await createDeliveryEvidencePackage({
      repositories,
      audit,
      runId: 'run_1',
      repoPath,
    });
    expect(evidence.ciStatuses).toEqual([]);
    const readiness = await evaluateWorkReadiness({
      repositories,
      audit,
      runId: 'run_1',
      repoPath,
    });
    expect(readiness.checks).toContainEqual(
      expect.objectContaining({
        id: 'remote-ci-passed',
        passed: false,
        evidence: 'remote CI status not checked',
      }),
    );
    db.close();
  });

  it('rejects unsafe run ids and escaped output directories before running gh', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-ci-safe-'));
    tempDirs.push(repoPath);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedCiRun({ repositories, repoPath });
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        throw new Error('should not run');
      },
    };

    await expect(
      queryPullRequestCiStatus({
        repoPath,
        runId: '../../outside',
        repositories,
        gateway,
        selector: 'https://github.example/org/repo/pull/7',
      }),
    ).rejects.toThrow('unsafe path segment');
    await expect(
      queryPullRequestCiStatus({
        repoPath,
        runId: 'run_1',
        repositories,
        gateway,
        selector: 'https://github.example/org/repo/pull/7',
        outputDir: join(tmpdir(), 'tekon-ci-escaped-output'),
      }),
    ).rejects.toThrow('CI outputDir escapes .tekon');
    expect(calls).toEqual([]);
    db.close();
  });

  it('records pending checks when gh exits with pending status but prints JSON', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-ci-pending-'));
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-ci-pending-output-'));
    tempDirs.push(repoPath, outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedCiRun({ repositories, repoPath });
    const stdoutPath = join(outputDir, 'checks.json');
    writeFileSync(
      stdoutPath,
      JSON.stringify([{ name: 'build', bucket: 'pending', state: 'QUEUED' }]),
      'utf8',
    );

    const report = await queryPullRequestCiStatus({
      repoPath,
      runId: 'run_1',
      repositories,
      gateway: {
        async run() {
          return {
            status: 'executed',
            exitCode: 8,
            signal: null,
            timedOut: false,
            stdoutPath,
            stderrPath: join(outputDir, 'checks.err'),
            durationMs: 1,
          };
        },
      },
    });

    expect(report.status).toBe('pending');
    db.close();
  });

  it('watches CI until a terminal status and records every attempt', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-ci-watch-'));
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-ci-watch-output-'));
    tempDirs.push(repoPath, outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedCiRun({ repositories, repoPath });
    const stdoutPath = join(outputDir, 'checks.json');
    const calls: CommandGatewayRunInput[] = [];
    const sleeps: number[] = [];
    const buckets = ['pending', 'pass'];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        const bucket = buckets.shift() ?? 'pass';
        writeFileSync(
          stdoutPath,
          JSON.stringify([{ name: 'build', bucket, state: bucket }]),
          'utf8',
        );
        return {
          status: 'executed',
          exitCode: bucket === 'pending' ? 8 : 0,
          signal: null,
          timedOut: false,
          stdoutPath,
          stderrPath: join(outputDir, 'checks.err'),
          durationMs: 1,
        };
      },
    };

    const result = await watchPullRequestCiStatus({
      repoPath,
      runId: 'run_1',
      repositories,
      audit,
      gateway,
      intervalMs: 10,
      backoffMultiplier: 2,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxAttempts: 3,
    });

    expect(result).toMatchObject({
      finalStatus: 'passed',
      terminal: true,
      attempts: 2,
      maxAttempts: 3,
    });
    expect(result.reports.map((report) => report.status)).toEqual([
      'pending',
      'passed',
    ]);
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([10]);
    expect(await repositories.listAuditEvents('run_1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delivery.ci.checked' }),
        expect.objectContaining({ type: 'delivery.ci.watch-completed' }),
      ]),
    );
    const artifacts = await repositories.listArtifacts('run_1');
    expect(
      artifacts.filter((artifact) => artifact.type === 'ci-status'),
    ).toHaveLength(2);
    db.close();
  });

  it('stops CI watch after max attempts when checks remain pending', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-ci-watch-pending-'));
    const outputDir = mkdtempSync(
      join(tmpdir(), 'tekon-ci-watch-pending-output-'),
    );
    tempDirs.push(repoPath, outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedCiRun({ repositories, repoPath });
    const stdoutPath = join(outputDir, 'checks.json');
    writeFileSync(
      stdoutPath,
      JSON.stringify([{ name: 'build', bucket: 'pending', state: 'QUEUED' }]),
      'utf8',
    );

    const result = await watchPullRequestCiStatus({
      repoPath,
      runId: 'run_1',
      repositories,
      audit,
      gateway: {
        async run() {
          return {
            status: 'executed',
            exitCode: 8,
            signal: null,
            timedOut: false,
            stdoutPath,
            stderrPath: join(outputDir, 'checks.err'),
            durationMs: 1,
          };
        },
      },
      intervalMs: 0,
      maxAttempts: 2,
    });

    expect(result).toMatchObject({
      finalStatus: 'pending',
      terminal: false,
      attempts: 2,
    });
    expect(await repositories.listAuditEvents('run_1')).toContainEqual(
      expect.objectContaining({
        type: 'delivery.ci.watch-completed',
        payload: expect.objectContaining({ terminal: false, attempts: 2 }),
      }),
    );
    db.close();
  });
});

async function seedCiRun(input: {
  repositories: ReturnType<typeof createRepositories>;
  repoPath: string;
}) {
  await input.repositories.createDemand({
    id: 'demand_1',
    title: 'CI evidence',
    body: 'Check PR CI status.',
    createdAt: '2026-06-08T00:00:00.000Z',
  });
  await input.repositories.createProject({
    id: 'project_1',
    name: 'tekon',
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
  await input.repositories.createPhase({
    id: 'phase_1',
    runId: 'run_1',
    name: 'Delivery',
    status: 'passed',
    order: 1,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:01.000Z',
  });
  await input.repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    phaseId: 'phase_1',
    role: 'pmo',
    status: 'passed',
    gates: [],
    dependencies: [],
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:01.000Z',
  });
  await input.repositories.upsertDeliveryPullRequest({
    id: 'delivery_pr_run_1',
    runId: 'run_1',
    branch: 'tekon-delivery/run_1',
    baseBranch: 'main',
    title: 'CI evidence',
    status: 'created',
    prUrl: 'https://github.example/org/repo/pull/7',
    attemptCount: 1,
    createdAt: '2026-06-08T00:00:00.000Z',
    updatedAt: '2026-06-08T00:00:01.000Z',
  });
}
