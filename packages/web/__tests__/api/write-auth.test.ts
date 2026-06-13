import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepositories, openTekonDatabase } from '@tekon/core';
import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller, dispatchApiCall } from '../../src/server/api/root.js';

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('web write authorization', () => {
  it('rejects write procedures with a wrong token and approves with the session token', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'wrong token',
        token: 'wrong-token',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const pendingBeforeApproval = await api.gate.list({ runId: 'run_1' });
    expect(pendingBeforeApproval.pendingDecisions[0]?.context).toMatchObject({
      approvalEvaluation: expect.objectContaining({ ready: true }),
      approvalSummary: expect.objectContaining({
        summaryText: expect.stringContaining('Tekon 审批摘要'),
        approveCommand: expect.stringContaining(
          'tekon resume --run-id run_1 --approve-human',
        ),
        rejectCommand: expect.stringContaining('tekon approval reject'),
      }),
    });

    const result = await api.gate.approve({
      runId: 'run_1',
      decisionId: 'decision_1',
      actor: 'human-reviewer',
      note: 'approved from test',
      token: fixture.sessionToken,
    });

    expect(result.decision).toMatchObject({
      id: 'decision_1',
      status: 'approved',
      actor: 'human-reviewer',
    });

    const gates = await api.gate.list({ runId: 'run_1' });
    expect(gates.gates).toContainEqual(
      expect.objectContaining({ id: 'gate_1', status: 'passed' }),
    );

    const detail = await api.project.detail({ projectId: 'project_1' });
    expect(detail.runs[0]).toMatchObject({
      id: 'run_1',
      status: 'passed',
      currentNodeId: null,
    });
    const audit = await api.audit.list({ runId: 'run_1' });
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'human.gate.approved' }),
        expect.objectContaining({ type: 'run.resumed' }),
      ]),
    );

    await expect(
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'duplicate',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });

  it('rejecting a human gate blocks the workflow instead of resuming it', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.gate.reject({
      runId: 'run_1',
      decisionId: 'decision_1',
      actor: 'human-reviewer',
      note: 'needs changes',
      token: fixture.sessionToken,
    });

    expect(result.decision).toMatchObject({
      id: 'decision_1',
      status: 'rejected',
      actor: 'human-reviewer',
    });
    const detail = await api.project.detail({ projectId: 'project_1' });
    expect(detail.runs[0]).toMatchObject({
      id: 'run_1',
      status: 'blocked',
      currentNodeId: 'node_1',
    });
    const gates = await api.gate.list({ runId: 'run_1' });
    expect(gates.gates).toContainEqual(
      expect.objectContaining({
        id: 'gate_1',
        status: 'failed',
        failureClassification: 'human-rejected',
      }),
    );
    const review = await api.review.get({ runId: 'run_1' });
    expect(review.gateFailureTriage).toContainEqual(
      expect.objectContaining({
        gateId: 'gate_1',
        classification: 'human-rejected',
        retry: 'not-recommended',
        summary: expect.stringContaining('human reviewer rejected'),
      }),
    );
    const audit = await api.audit.list({ runId: 'run_1' });
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'human.gate.rejected' }),
      ]),
    );
    expect(audit.events).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'run.resumed' }),
      ]),
    );

    await api.close();
  });

  it('does not approve a human gate when the run provider snapshot is missing', async () => {
    const fixture = await createWebFixtureProject({
      includeProviderSnapshot: false,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'cannot resume safely',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const gates = await api.gate.list({ runId: 'run_1' });
    expect(gates.pendingDecisions).toContainEqual(
      expect.objectContaining({ id: 'decision_1', status: 'pending' }),
    );

    await api.close();
  });

  it('approves a human gate when the run has a Codex provider snapshot', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const db = openTekonDatabase({
      filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
    });
    await createRepositories(db).recordRunProviderConfig({
      runId: 'run_1',
      provider: 'codex',
      configSummary: {
        provider: 'codex',
        command: 'codex',
        args: [],
        profile: 'internal',
        promptMode: 'stdin',
        outputFormat: 'text',
        timeoutMs: 300_000,
        permissionProfile: {
          sandbox: 'workspace-write',
          approval: 'on-request',
          filesystemScope: [fixture.projectRoot],
          network: 'restricted',
          tools: {
            allow: ['git', 'npm', 'pnpm'],
            deny: ['rm', 'sudo', 'git push --force'],
          },
        },
      },
      createdAt: '2026-06-10T00:00:00.000Z',
    });
    db.close();
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.gate.approve({
      runId: 'run_1',
      decisionId: 'decision_1',
      actor: 'human-reviewer',
      note: 'codex snapshot can resume',
      token: fixture.sessionToken,
    });

    expect(result.decision).toMatchObject({
      id: 'decision_1',
      status: 'approved',
    });

    await api.close();
  });

  it('rejects run writes outside the explicit project root even with a valid token', async () => {
    const fixture = await createWebFixtureProject({
      includeOutOfScopeProject: true,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.project.pause({
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.project.resume({
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.project.cancel({
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.project.clean({
        runId: 'run_escaped',
        token: fixture.sessionToken,
        confirm: 'delete-run-dir',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.delivery.prepare({
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      api.delivery.createPr({
        runId: 'run_escaped',
        token: fixture.sessionToken,
        approveHuman: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await api.close();
  });

  it('starts a Web run and drives delivery prepare/create-pr approval state', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.project.run({
        demandText: 'Web should be able to start a controlled mock run.',
        template: 'project-feature',
        agent: 'mock',
        token: 'wrong-token',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const started = await api.project.run({
      demandText: 'Web should be able to start a controlled mock run.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });

    expect(started.run).toMatchObject({
      status: 'passed',
      currentNodeId: null,
    });

    const overview = await api.project.overview();
    expect(overview.latestRun).toMatchObject({ id: started.run.id });
    await expect(
      api.artifact.list({ runId: started.run.id }),
    ).resolves.toMatchObject({
      artifacts: expect.arrayContaining([
        expect.objectContaining({
          type: 'demand-card',
        }),
        expect.objectContaining({
          type: 'code-changes',
        }),
        expect.objectContaining({
          type: 'qa-release-signoff',
        }),
      ]),
    });

    const prepared = await api.delivery.prepare({
      runId: started.run.id,
      token: fixture.sessionToken,
    });
    expect(prepared).toMatchObject({
      runId: started.run.id,
      branch: `tekon-delivery/${started.run.id}`,
      requiresHumanApproval: true,
    });

    const review = await api.review.get({ runId: started.run.id });
    expect(review.delivery.package?.content).toContain('PR Preparation');
    expect(review.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'code-changes' }),
        expect.objectContaining({ type: 'delivery-package' }),
      ]),
    );

    await api.close();
  }, 30_000);

  it('starts a Codex provider run from Web and stores a resumable provider snapshot', async () => {
    const fixture = await createWebFixtureProject();
    const binDir = mkdtempSync(join(tmpdir(), 'tekon-web-codex-bin-'));
    cleanupTasks.push(fixture.cleanup);
    cleanupTasks.push(() => rmSync(binDir, { recursive: true, force: true }));
    writeFakeCodex(binDir);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    try {
      const started = await api.project.run({
        demandText:
          'Web should be able to start a controlled Codex provider run.',
        template: 'project-feature',
        agent: 'codex',
        timeoutMs: 7_200_000,
        noProgressTimeoutMs: 1_200_000,
        progressHeartbeatMs: 30_000,
        token: fixture.sessionToken,
      });

      expect(started.run).toMatchObject({
        status: 'passed',
        currentNodeId: null,
      });

      const db = openTekonDatabase({
        filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite'),
      });
      const provider = await createRepositories(db).getRunProviderConfig(
        started.run.id,
      );
      expect(provider).toMatchObject({
        provider: 'codex',
        configSummary: expect.objectContaining({
          provider: 'codex',
          command: 'codex',
          args: [],
          profile: 'internal',
          promptMode: 'stdin',
          outputFormat: 'text',
          timeoutMs: 7_200_000,
          noProgressTimeoutMs: 1_200_000,
          progressHeartbeatMs: 30_000,
        }),
      });
      db.close();
    } finally {
      process.env.PATH = originalPath;
      await api.close();
    }
  });

  it('shapes and approves a draft before starting a Web run', { timeout: 15000 }, async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.draftShape.shape({
        demandText: '给 Web dashboard 增加需求塑形入口，要求 e2e 通过。',
        token: 'wrong-token',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const shaped = await api.draftShape.shape({
      demandText: '给 Web dashboard 增加需求塑形入口，要求 e2e 通过。',
      token: fixture.sessionToken,
    });
    expect(shaped.shape).toMatchObject({
      category: 'feature',
      recommendedTemplate: 'standard-feature',
      approved: false,
    });
    expect(readFileSync(shaped.shapePath, 'utf8')).toContain(
      '"approved": false',
    );

    await expect(
      api.project.run({
        demandText: '',
        demandShapePath: shaped.shapePath,
        agent: 'mock',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    const approved = await api.draftShape.approve({
      shapePath: shaped.shapePath,
      token: fixture.sessionToken,
      actor: 'web-test',
    });
    expect(approved.shape).toMatchObject({
      approved: true,
      approvedBy: 'web-test',
    });

    const started = await api.project.run({
      demandText: '',
      demandShapePath: shaped.shapePath,
      agent: 'mock',
      token: fixture.sessionToken,
    });
    expect(started.run).toMatchObject({ status: 'passed' });

    await expect(
      api.draftShape.approve({
        shapePath: join(fixture.projectRoot, 'package.json'),
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });

  it('rejects draft shape symlink escapes in Web write paths', async () => {
    const fixture = await createWebFixtureProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'tekon-web-shape-outside-'));
    cleanupTasks.push(fixture.cleanup);
    cleanupTasks.push(() =>
      rmSync(outsideDir, { recursive: true, force: true }),
    );
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const shaped = await api.draftShape.shape({
      demandText: '给 Web dashboard 增加需求塑形入口，要求 e2e 通过。',
      token: fixture.sessionToken,
    });
    const outsideShapePath = join(outsideDir, 'outside-shape.json');
    writeFileSync(outsideShapePath, readFileSync(shaped.shapePath, 'utf8'));
    rmSync(shaped.shapePath);
    symlinkSync(outsideShapePath, shaped.shapePath);

    await expect(
      api.draftShape.approve({
        shapePath: shaped.shapePath,
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.project.run({
        demandText: '',
        demandShapePath: shaped.shapePath,
        agent: 'mock',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    rmSync(join(fixture.projectRoot, '.tekon', 'drafts'), {
      recursive: true,
      force: true,
    });
    mkdirSync(outsideDir, { recursive: true });
    const outsideDirShapePath = join(outsideDir, 'dir-shape.json');
    writeFileSync(outsideDirShapePath, readFileSync(outsideShapePath, 'utf8'));
    symlinkSync(
      outsideDir,
      join(fixture.projectRoot, '.tekon', 'drafts'),
      'dir',
    );
    const escapedViaDraftDir = join(
      fixture.projectRoot,
      '.tekon',
      'demands',
      'dir-shape.json',
    );

    await expect(
      api.draftShape.approve({
        shapePath: escapedViaDraftDir,
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.project.run({
        demandText: '',
        demandShapePath: escapedViaDraftDir,
        agent: 'mock',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });

  it('rejects draft shape writes when drafts storage is a symlink', async () => {
    const fixture = await createWebFixtureProject();
    const outsideDir = mkdtempSync(
      join(tmpdir(), 'tekon-web-shape-write-outside-'),
    );
    cleanupTasks.push(fixture.cleanup);
    cleanupTasks.push(() =>
      rmSync(outsideDir, { recursive: true, force: true }),
    );
    const draftsPath = join(fixture.projectRoot, '.tekon', 'drafts');
    rmSync(draftsPath, { recursive: true, force: true });
    symlinkSync(outsideDir, draftsPath, 'dir');
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.draftShape.shape({
        demandText: '给 Web dashboard 增加需求塑形入口，要求 e2e 通过。',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(readdirSync(outsideDir)).toEqual([]);

    await api.close();
  });

  it('requires explicit dirty-base approval before starting a Web run', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    writeFileSync(join(fixture.projectRoot, 'README.md'), 'dirty\n', 'utf8');

    await expect(
      api.project.run({
        demandText: 'This run should be blocked by dirty base.',
        template: 'standard-feature',
        agent: 'mock',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });

  it('creates a PR through the approved Web delivery path with fake gh', async () => {
    const fixture = await createWebFixtureProject();
    const remotePath = mkdtempSync(join(tmpdir(), 'tekon-web-remote-'));
    const binDir = mkdtempSync(join(tmpdir(), 'tekon-web-fake-gh-'));
    cleanupTasks.push(fixture.cleanup);
    cleanupTasks.push(() =>
      rmSync(remotePath, { recursive: true, force: true }),
    );
    cleanupTasks.push(() => rmSync(binDir, { recursive: true, force: true }));
    execFileSync('git', ['init', '--bare'], { cwd: remotePath });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: fixture.projectRoot,
    });
    writeFakeGh(binDir);
    const api = await createApiCaller({
      projectRoot: fixture.projectRoot,
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` },
    });
    const started = await api.project.run({
      demandText:
        'Web should create a PR only after standard delivery evidence is complete.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });

    const result = await api.delivery.createPr({
      runId: started.run.id,
      token: fixture.sessionToken,
      approveHuman: true,
    });

    expect(result).toMatchObject({
      runId: started.run.id,
      deliveryStatus: 'created',
      requiresHumanApproval: false,
      prUrl: 'https://github.example/tekon/pull/10',
      failureStage: null,
      branch: `tekon-delivery/${started.run.id}`,
    });
    const audit = await api.audit.list({ runId: started.run.id });
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delivery.pr.created' }),
      ]),
    );

    await api.close();
  }, 30_000);
});

describe('project.clean', () => {
  it('removes the run directory from disk and reports removedRunDir true', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const runDir = join(fixture.projectRoot, '.tekon', 'runs', 'run_1');
    expect(existsSync(runDir)).toBe(true);

    const result = await dispatchApiCall(api, 'project.clean', {
      runId: 'run_1',
      token: fixture.sessionToken,
      confirm: 'delete-run-dir',
    });
    expect(result).toMatchObject({ removedRunDir: true });
    expect(existsSync(runDir)).toBe(false);

    await api.close();
  });

  it('rejects project.clean with a wrong token', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.project.clean({ runId: 'run_1', token: 'wrong-token', confirm: 'delete-run-dir' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    expect(
      existsSync(join(fixture.projectRoot, '.tekon', 'runs', 'run_1')),
    ).toBe(true);

    await api.close();
  });

  it('rejects project.clean for an out-of-scope run', async () => {
    const fixture = await createWebFixtureProject({
      includeOutOfScopeProject: true,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      dispatchApiCall(api, 'project.clean', {
        runId: 'run_escaped',
        token: fixture.sessionToken,
        confirm: 'delete-run-dir',
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await api.close();
  });
});

describe('project.resume', () => {
  it('rejects project.resume with a wrong token', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.project.resume({ runId: 'run_1', token: 'wrong-token' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await api.close();
  });

  it('rejects project.resume for an out-of-scope run', async () => {
    const fixture = await createWebFixtureProject({
      includeOutOfScopeProject: true,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      dispatchApiCall(api, 'project.resume', {
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await api.close();
  });

  it('rejects project.resume when the run has pending human decisions', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.project.resume({
        runId: 'run_1',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });
});

describe('delivery.prepare', () => {
  it('rejects delivery.prepare with a wrong token', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.delivery.prepare({ runId: 'run_1', token: 'wrong-token' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await api.close();
  });

  it('rejects delivery.prepare for an out-of-scope run', async () => {
    const fixture = await createWebFixtureProject({
      includeOutOfScopeProject: true,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      dispatchApiCall(api, 'delivery.prepare', {
        runId: 'run_escaped',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await api.close();
  });
});

describe('delivery.dryRun', () => {
  it('is read-only: does NOT create artifacts or audit events and returns readiness info', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    // Snapshot artifact and audit counts before calling dryRun
    const artifactsBefore = await api.artifact.list({ runId: 'run_1' });
    const auditBefore = await api.audit.list({ runId: 'run_1' });

    const result = await api.delivery.dryRun({
      runId: 'run_1',
      token: fixture.sessionToken,
    });

    // Assert no new artifacts were created
    const artifactsAfter = await api.artifact.list({ runId: 'run_1' });
    expect(artifactsAfter.artifacts).toHaveLength(
      artifactsBefore.artifacts.length,
    );

    // Assert no new audit events were created
    const auditAfter = await api.audit.list({ runId: 'run_1' });
    expect(auditAfter.events).toHaveLength(auditBefore.events.length);

    // Assert the response contains readiness info
    expect(result).toMatchObject({
      runId: 'run_1',
      workflowStatus: 'paused',
      artifacts: expect.any(Number),
      gates: {
        total: expect.any(Number),
        passed: expect.any(Number),
      },
      pendingHumanDecisions: expect.any(Number),
      deliveryStatus: expect.any(String),
      readyForPrepare: false,
      dryRun: true,
    });

    // run_1 is paused with a pending human decision, so not ready
    expect(result.readyForPrepare).toBe(false);
    expect(result.pendingHumanDecisions).toBeGreaterThan(0);

    await api.close();
  });

  it('returns readyForPrepare true when all pre-conditions are met', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    // Start a fresh run that will complete with status 'passed'
    const started = await api.project.run({
      demandText: 'Dry run readiness check with all pre-conditions met.',
      template: 'standard-delivery',
      agent: 'mock',
      token: fixture.sessionToken,
    });

    expect(started.run.status).toBe('passed');

    // Snapshot artifact and audit counts before calling dryRun
    const artifactsBefore = await api.artifact.list({ runId: started.run.id });
    const auditBefore = await api.audit.list({ runId: started.run.id });

    const result = await api.delivery.dryRun({
      runId: started.run.id,
      token: fixture.sessionToken,
    });

    // Assert no new artifacts were created by dryRun
    const artifactsAfter = await api.artifact.list({ runId: started.run.id });
    expect(artifactsAfter.artifacts).toHaveLength(
      artifactsBefore.artifacts.length,
    );

    // Assert no new audit events were created by dryRun
    const auditAfter = await api.audit.list({ runId: started.run.id });
    expect(auditAfter.events).toHaveLength(auditBefore.events.length);

    // Assert dryRun reports ready
    expect(result).toMatchObject({
      runId: started.run.id,
      workflowStatus: 'passed',
      readyForPrepare: true,
      dryRun: true,
      pendingHumanDecisions: 0,
    });

    await api.close();
  }, 30_000);

  it('rejects delivery.dryRun with a wrong token', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.delivery.dryRun({ runId: 'run_1', token: 'wrong-token' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await api.close();
  });
});

describe('delivery.createPr', () => {
  it('rejects delivery.createPr with a wrong token', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.delivery.createPr({
        runId: 'run_1',
        token: 'wrong-token',
        approveHuman: true,
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await api.close();
  });

  it('rejects delivery.createPr for an out-of-scope run', async () => {
    const fixture = await createWebFixtureProject({
      includeOutOfScopeProject: true,
    });
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      dispatchApiCall(api, 'delivery.createPr', {
        runId: 'run_escaped',
        token: fixture.sessionToken,
        approveHuman: true,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });

    await api.close();
  });

  it('rejects delivery.createPr when approveHuman is not true', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      dispatchApiCall(api, 'delivery.createPr', {
        runId: 'run_1',
        token: fixture.sessionToken,
        approveHuman: false,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await expect(
      dispatchApiCall(api, 'delivery.createPr', {
        runId: 'run_1',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });
});

describe('security characterization (documents current behavior, some will change in Phase 1)', () => {
  describe('token validation edge cases', () => {
    it('rejects write operations with an empty token string', async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      await expect(
        api.gate.approve({
          runId: 'run_1',
          decisionId: 'decision_1',
          actor: 'human-reviewer',
          note: 'empty token',
          token: '',
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await expect(
        api.project.run({
          demandText: 'should fail with empty token',
          template: 'project-feature',
          agent: 'mock',
          token: '',
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await expect(
        api.draftShape.shape({
          demandText: 'should fail with empty token',
          token: '',
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await api.close();
    });

    it('rejects write operations with a wrong token across all write endpoints', async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      await expect(
        api.project.pause({
          runId: 'run_1',
          token: 'incorrect-token-value',
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await expect(
        api.project.resume({
          runId: 'run_1',
          token: 'incorrect-token-value',
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await expect(
        api.project.cancel({
          runId: 'run_1',
          token: 'incorrect-token-value',
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await expect(
        api.delivery.prepare({
          runId: 'run_1',
          token: 'incorrect-token-value',
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await api.close();
    });

    it('rejects write operations when the session token file is missing', async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      rmSync(join(fixture.projectRoot, '.tekon', 'web-session.json'));

      await expect(
        api.gate.approve({
          runId: 'run_1',
          decisionId: 'decision_1',
          actor: 'human-reviewer',
          note: 'missing token file',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await expect(
        api.project.pause({
          runId: 'run_1',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await expect(
        api.draftShape.shape({
          demandText: 'should fail without token file',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

      await api.close();
    });
  });

  describe('path scope enforcement', () => {
    it('returns NOT_FOUND when the runId belongs to a different project scope', async () => {
      const fixture = await createWebFixtureProject({
        includeOutOfScopeProject: true,
      });
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      await expect(
        api.project.pause({
          runId: 'run_escaped',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        api.project.resume({
          runId: 'run_escaped',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        api.gate.approve({
          runId: 'run_escaped',
          decisionId: 'decision_1',
          actor: 'human-reviewer',
          note: 'out of scope run',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        api.delivery.prepare({
          runId: 'run_escaped',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await api.close();
    });

    it('returns NOT_FOUND for a completely nonexistent runId', async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      await expect(
        api.project.pause({
          runId: 'run_does_not_exist',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await expect(
        api.gate.approve({
          runId: 'run_does_not_exist',
          decisionId: 'decision_1',
          actor: 'human-reviewer',
          note: 'nonexistent run',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });

      await api.close();
    });

    it('rejects draft approve when the shape path is outside .tekon/drafts/', async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      await expect(
        api.draftShape.approve({
          shapePath: join(fixture.projectRoot, 'package.json'),
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await expect(
        api.draftShape.approve({
          shapePath: '/tmp/outside-drafts-dir/shape.json',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await expect(
        api.project.run({
          demandText: '',
          demandShapePath: join(fixture.projectRoot, 'package.json'),
          agent: 'mock',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await api.close();
    });

    it('rejects draft operations when the shape path is a symlink escaping the drafts directory', async () => {
      const fixture = await createWebFixtureProject();
      const outsideDir = mkdtempSync(join(tmpdir(), 'tekon-sec-symlink-'));
      cleanupTasks.push(fixture.cleanup);
      cleanupTasks.push(() =>
        rmSync(outsideDir, { recursive: true, force: true }),
      );
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      const shaped = await api.draftShape.shape({
        demandText: 'Security test: symlink escape in demand shape path.',
        token: fixture.sessionToken,
      });
      const outsidePath = join(outsideDir, 'escaped-shape.json');
      writeFileSync(outsidePath, readFileSync(shaped.shapePath, 'utf8'));
      rmSync(shaped.shapePath);
      symlinkSync(outsidePath, shaped.shapePath);

      await expect(
        api.draftShape.approve({
          shapePath: shaped.shapePath,
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await expect(
        api.project.run({
          demandText: '',
          demandShapePath: shaped.shapePath,
          agent: 'mock',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await api.close();
    });
  });

  describe('state validation', () => {
    it('rejects approving an already-approved decision with BAD_REQUEST', async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      await api.gate.approve({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'first approval',
        token: fixture.sessionToken,
      });

      await expect(
        api.gate.approve({
          runId: 'run_1',
          decisionId: 'decision_1',
          actor: 'human-reviewer',
          note: 'duplicate approval attempt',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await api.close();
    });

    it('rejects rejecting an already-rejected decision with BAD_REQUEST', async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      await api.gate.reject({
        runId: 'run_1',
        decisionId: 'decision_1',
        actor: 'human-reviewer',
        note: 'first rejection',
        token: fixture.sessionToken,
      });

      await expect(
        api.gate.reject({
          runId: 'run_1',
          decisionId: 'decision_1',
          actor: 'human-reviewer',
          note: 'duplicate rejection attempt',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await expect(
        api.gate.approve({
          runId: 'run_1',
          decisionId: 'decision_1',
          actor: 'human-reviewer',
          note: 'approve after rejection',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await api.close();
    });

    it('rejects starting a run with an unapproved draft shape', async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      const shaped = await api.draftShape.shape({
        demandText: 'Security test: run with unapproved demand shape.',
        token: fixture.sessionToken,
      });
      expect(shaped.shape.approved).toBe(false);

      await expect(
        api.project.run({
          demandText: '',
          demandShapePath: shaped.shapePath,
          agent: 'mock',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await api.close();
    });

    it('rejects starting a run with dirty base and no allowDirtyBase flag', async () => {
      const fixture = await createWebFixtureProject();
      cleanupTasks.push(fixture.cleanup);
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });

      writeFileSync(
        join(fixture.projectRoot, 'README.md'),
        'dirty change for security test\n',
        'utf8',
      );

      await expect(
        api.project.run({
          demandText: 'Security test: dirty base without allowDirtyBase.',
          template: 'standard-feature',
          agent: 'mock',
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

      await api.close();
    });
  });
});

function writeFakeCodex(binDir: string): void {
  const codexPath = join(binDir, 'codex');
  writeFileSync(
    codexPath,
    `#!/usr/bin/env node
const { writeFileSync, mkdirSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const execIndex = args.indexOf('exec');
if (execIndex === -1) {
  console.error('expected codex exec, got: ' + args.join(' '));
  process.exit(2);
}
if (args.indexOf('--profile') === -1 || args.indexOf('--profile') > execIndex || args[args.indexOf('--profile') + 1] !== 'internal') {
  console.error('expected internal profile before exec, got: ' + args.join(' '));
  process.exit(2);
}
if (args.indexOf('--ask-for-approval') === -1 || args.indexOf('--ask-for-approval') > execIndex) {
  console.error('expected approval before exec, got: ' + args.join(' '));
  process.exit(2);
}
if (args.indexOf('--sandbox') === -1 || args.indexOf('--sandbox') > execIndex) {
  console.error('expected sandbox before exec, got: ' + args.join(' '));
  process.exit(2);
}
if (args.indexOf('--add-dir') === -1 || args.indexOf('--add-dir') > execIndex || args[args.indexOf('--add-dir') + 1] !== process.env.TEKON_OUTPUT_DIR) {
  console.error('expected controlled artifact output add-dir before exec, got: ' + args.join(' '));
  process.exit(2);
}
if (args.includes('danger-full-access') || args.includes('--dangerously-bypass-approvals-and-sandbox')) {
  console.error('unsafe codex args');
  process.exit(3);
}
let prompt = '';
process.stdin.on('data', (chunk) => {
  prompt += chunk;
});
process.stdin.on('end', () => {
  const outputDir = process.env.TEKON_OUTPUT_DIR;
  const manifestPath = process.env.TEKON_ARTIFACT_MANIFEST;
  if (!outputDir || !manifestPath) {
    console.error('missing Tekon artifact environment');
    process.exit(4);
  }
  mkdirSync(outputDir, { recursive: true });
  const types = Array.from(new Set((prompt.match(/Required artifact types: ([^\\.]+)/) || ['', ''])[1].split(',').map((item) => item.trim()).filter(Boolean)));
  const deliveryRef = (prompt.match(/exact tested delivery ref: ([^\\.\\n]+)/) || ['', 'codex-fixture-ref'])[1];
  const artifacts = types.map((type) => {
    const filename = type + '.json';
    const base = {
      title: type + ' artifact',
      body: 'Codex fixture artifact for ' + type + '.',
      summary: 'Codex fixture artifact for ' + type + '.'
    };
    let payload = base;
    if (type === 'demand-card' || type === 'prd') {
      payload = {
        ...base,
        acceptanceCriteria: [{
          id: 'AC-1',
          description: 'The Codex provider run stores a resumable provider snapshot.',
          verification: 'Inspect run_provider_configs for provider=codex.'
        }]
      };
    } else if (type === 'test-report' || type === 'review-report' || type === 'delivery-package') {
      payload = {
        ...base,
        criteriaEvidence: [{
          criterionId: 'AC-1',
          status: 'passed',
          evidence: 'Codex fixture produced schema-valid evidence for ' + type + '.'
        }]
      };
    } else if (type === 'qa-release-signoff') {
      payload = {
        ...base,
        targetRef: deliveryRef,
        validatedRef: deliveryRef,
        overallStatus: 'passed',
        criteriaEvidence: [{
          criterionId: 'AC-1',
          status: 'passed',
          evidence: 'Codex fixture QA signoff validates ' + deliveryRef + '.'
        }]
      };
    } else if (type === 'security-report') {
      payload = { ...base, securityFindings: [] };
    }
    writeFileSync(join(outputDir, filename), JSON.stringify(payload));
    return { type, path: filename, summary: 'Codex fixture artifact for ' + type + '.' };
  });
  writeFileSync(manifestPath, JSON.stringify({ artifacts }));
  console.log('fake codex completed');
});
`,
    'utf8',
  );
  chmodSync(codexPath, 0o755);
}

function writeFakeGh(binDir: string): void {
  const ghPath = join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env sh
echo "$*" >> "${join(binDir, 'gh.log')}"
if [ "$1 $2" = "auth status" ]; then
  echo "Logged in to github.example" >&2
  exit 0
fi
echo "https://github.example/tekon/pull/10"
`,
    'utf8',
  );
  chmodSync(ghPath, 0o755);
}
