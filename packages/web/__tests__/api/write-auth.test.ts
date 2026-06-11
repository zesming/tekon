import { execFileSync } from 'node:child_process';
import {
  chmodSync,
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
import { createApiCaller } from '../../src/server/api/root.js';

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
        approveHuman: false,
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
      template: 'project-feature',
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
      artifacts: [
        expect.objectContaining({
          type: 'code-changes',
        }),
        expect.objectContaining({
          type: 'review-report',
        }),
      ],
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

    const awaiting = await api.delivery.createPr({
      runId: started.run.id,
      token: fixture.sessionToken,
      approveHuman: false,
    });
    expect(awaiting).toMatchObject({
      runId: started.run.id,
      deliveryStatus: 'awaiting-approval',
      requiresHumanApproval: true,
      prUrl: null,
      branch: `tekon-delivery/${started.run.id}`,
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
  });

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
          timeoutMs: 3_600_000,
        }),
      });
      db.close();
    } finally {
      process.env.PATH = originalPath;
      await api.close();
    }
  });

  it('shapes and approves a demand before starting a Web run', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.demand.shape({
        demandText: '给 Web dashboard 增加需求塑形入口，要求 e2e 通过。',
        token: 'wrong-token',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    const shaped = await api.demand.shape({
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

    const approved = await api.demand.approve({
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
      api.demand.approve({
        shapePath: join(fixture.projectRoot, 'package.json'),
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });

  it('rejects demand shape symlink escapes in Web write paths', async () => {
    const fixture = await createWebFixtureProject();
    const outsideDir = mkdtempSync(join(tmpdir(), 'tekon-web-shape-outside-'));
    cleanupTasks.push(fixture.cleanup);
    cleanupTasks.push(() =>
      rmSync(outsideDir, { recursive: true, force: true }),
    );
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const shaped = await api.demand.shape({
      demandText: '给 Web dashboard 增加需求塑形入口，要求 e2e 通过。',
      token: fixture.sessionToken,
    });
    const outsideShapePath = join(outsideDir, 'outside-shape.json');
    writeFileSync(outsideShapePath, readFileSync(shaped.shapePath, 'utf8'));
    rmSync(shaped.shapePath);
    symlinkSync(outsideShapePath, shaped.shapePath);

    await expect(
      api.demand.approve({
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

    rmSync(join(fixture.projectRoot, '.tekon', 'demands'), {
      recursive: true,
      force: true,
    });
    mkdirSync(outsideDir, { recursive: true });
    const outsideDirShapePath = join(outsideDir, 'dir-shape.json');
    writeFileSync(outsideDirShapePath, readFileSync(outsideShapePath, 'utf8'));
    symlinkSync(
      outsideDir,
      join(fixture.projectRoot, '.tekon', 'demands'),
      'dir',
    );
    const escapedViaDemandDir = join(
      fixture.projectRoot,
      '.tekon',
      'demands',
      'dir-shape.json',
    );

    await expect(
      api.demand.approve({
        shapePath: escapedViaDemandDir,
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.project.run({
        demandText: '',
        demandShapePath: escapedViaDemandDir,
        agent: 'mock',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });

  it('rejects demand shape writes when demands storage is a symlink', async () => {
    const fixture = await createWebFixtureProject();
    const outsideDir = mkdtempSync(
      join(tmpdir(), 'tekon-web-shape-write-outside-'),
    );
    cleanupTasks.push(fixture.cleanup);
    cleanupTasks.push(() =>
      rmSync(outsideDir, { recursive: true, force: true }),
    );
    const demandsPath = join(fixture.projectRoot, '.tekon', 'demands');
    rmSync(demandsPath, { recursive: true, force: true });
    symlinkSync(outsideDir, demandsPath, 'dir');
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.demand.shape({
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

    const result = await api.delivery.createPr({
      runId: 'run_1',
      token: fixture.sessionToken,
      approveHuman: true,
    });

    expect(result).toMatchObject({
      runId: 'run_1',
      deliveryStatus: 'created',
      requiresHumanApproval: false,
      prUrl: 'https://github.example/tekon/pull/10',
      failureStage: null,
      branch: 'tekon-delivery/run_1',
    });
    const audit = await api.audit.list({ runId: 'run_1' });
    expect(audit.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delivery.pr.created' }),
      ]),
    );

    await api.close();
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
