import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import type {
  CommandGateway,
  CommandGatewayRunInput,
} from '../../src/runtime/command-gateway.js';
import { createScmDelivery } from '../../src/delivery/scm.js';
import {
  createAuditLogger,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '../../src/index.js';

describe('scm delivery', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('dry-runs push and PR commands without side effects and requires approval before push', async () => {
    const repoPath = createGitRepo(tempDirs);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');

    const delivery = createScmDelivery({ repoPath });
    const result = await delivery.createPr({
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      branch: 'donkey/phase-3',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.commands.map((command) => command.join(' '))).toEqual([
      'git branch donkey/phase-3',
      'git push -u origin donkey/phase-3',
      'gh pr create --title Phase 3 delivery --body Evidence body --head donkey/phase-3 --base main',
    ]);
    expect(
      execFileSync('git', ['status', '--short'], {
        cwd: repoPath,
        encoding: 'utf8',
      }),
    ).toContain('feature.txt');
  });

  it('captures a PR URL from a fake gh fixture after human-approved push', async () => {
    const repoPath = createGitRepo(tempDirs);
    const remotePath = mkdtempSync(join(tmpdir(), 'donkey-remote-'));
    const binDir = mkdtempSync(join(tmpdir(), 'donkey-fake-gh-'));
    tempDirs.push(remotePath, binDir);
    execFileSync('git', ['init', '--bare'], { cwd: remotePath });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: repoPath,
    });
    writeFakeGh(binDir);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');
    execFileSync('git', ['add', 'feature.txt'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'feature'], { cwd: repoPath });

    const delivery = createScmDelivery({
      repoPath,
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    });
    const result = await delivery.createPr({
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      branch: 'donkey/phase-3',
      dryRun: false,
      humanApproved: true,
    });

    expect(result.prUrl).toBe('https://github.example/donkey/pull/1');
    expect(result.requiresHumanApproval).toBe(false);
    expect(readFileSync(join(binDir, 'gh.log'), 'utf8')).toContain('pr create');
  });

  it('reports remote, current branch, dirty worktree, auth, and approval requirements', async () => {
    const repoPath = createGitRepo(tempDirs);
    const remotePath = mkdtempSync(join(tmpdir(), 'donkey-remote-'));
    const binDir = mkdtempSync(join(tmpdir(), 'donkey-fake-gh-auth-'));
    tempDirs.push(remotePath, binDir);
    execFileSync('git', ['init', '--bare'], { cwd: remotePath });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: repoPath,
    });
    writeFakeGh(binDir, { authenticated: true });
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');

    const delivery = createScmDelivery({
      repoPath,
      env: { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    });

    const status = await delivery.getStatus({ branch: 'donkey/phase-3' });

    expect(status).toMatchObject({
      hasRemote: true,
      remoteName: 'origin',
      remoteUrl: remotePath,
      dirty: true,
      ghAuthenticated: true,
      branchPushed: false,
      pushRequiresHumanApproval: true,
      prRequiresHumanApproval: true,
    });
    expect(status.currentBranch).toBeTruthy();
  });

  it('uses CommandGateway argv commands for approved push and PR creation', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'donkey-scm-logs-'));
    tempDirs.push(outputDir);
    const stdoutPath = join(outputDir, 'gh-pr.stdout.log');
    writeFileSync(stdoutPath, 'https://github.example/donkey/pull/2\n', 'utf8');
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        return {
          status: 'executed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath:
            input.command.tool === 'gh' && input.command.args[0] === 'pr'
              ? stdoutPath
              : join(outputDir, `${calls.length}.stdout.log`),
          stderrPath: join(outputDir, `${calls.length}.stderr.log`),
          durationMs: 1,
        };
      },
    };

    const delivery = createScmDelivery({ repoPath, gateway, outputDir });
    const result = await delivery.createPr({
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      branch: 'donkey/phase-3',
      dryRun: false,
      humanApproved: true,
    });

    expect(result.prUrl).toBe('https://github.example/donkey/pull/2');
    expect(calls.map((call) => call.command)).toEqual([
      { tool: 'git', args: ['branch', 'donkey/phase-3'] },
      { tool: 'git', args: ['push', '-u', 'origin', 'donkey/phase-3'] },
      {
        tool: 'gh',
        args: [
          'pr',
          'create',
          '--title',
          'Phase 3 delivery',
          '--body',
          'Evidence body',
          '--head',
          'donkey/phase-3',
          '--base',
          'main',
        ],
      },
    ]);
    expect(
      calls.every(
        (call) =>
          call.cwd === repoPath &&
          call.policy.network === 'enabled' &&
          call.policy.cwdScope.includes(repoPath),
      ),
    ).toBe(true);
  });

  it('records awaiting approval before remote PR side effects', async () => {
    const repoPath = createGitRepo(tempDirs);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);

    const delivery = createScmDelivery({ repoPath, repositories });
    const result = await delivery.createPr({
      runId: 'run_1',
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      bodyPath: '.donkey/runs/run_1/delivery/pr-body.md',
      branch: 'donkey/phase-3',
      baseBranch: 'main',
      dryRun: false,
    });

    expect(result.requiresHumanApproval).toBe(true);
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'awaiting-approval',
      branch: 'donkey/phase-3',
      baseBranch: 'main',
      bodyPath: '.donkey/runs/run_1/delivery/pr-body.md',
    });
    db.close();
  });

  it('persists PR URL and audit event after approved creation', async () => {
    const repoPath = createGitRepo(tempDirs);
    const remotePath = mkdtempSync(join(tmpdir(), 'donkey-remote-'));
    const outputDir = mkdtempSync(join(tmpdir(), 'donkey-scm-logs-'));
    tempDirs.push(remotePath, outputDir);
    execFileSync('git', ['init', '--bare'], { cwd: remotePath });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: repoPath,
    });
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');
    execFileSync('git', ['add', 'feature.txt'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'feature'], { cwd: repoPath });
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedRun(repositories);

    const stdoutPath = join(outputDir, 'gh-pr.stdout.log');
    writeFileSync(stdoutPath, 'https://github.example/donkey/pull/3\n', 'utf8');
    const gateway: CommandGateway = {
      async run(input) {
        if (input.command.tool === 'gh') {
          return executed(stdoutPath, join(outputDir, 'gh.stderr.log'));
        }
        return executed(
          join(outputDir, `${input.command.tool}-${input.command.args[0]}.out`),
          join(outputDir, `${input.command.tool}-${input.command.args[0]}.err`),
        );
      },
    };

    const result = await createScmDelivery({
      repoPath,
      repositories,
      audit,
      gateway,
      outputDir,
    }).createPr({
      runId: 'run_1',
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      branch: 'donkey/phase-3',
      dryRun: false,
      humanApproved: true,
      approvedBy: 'test',
    });

    expect(result.prUrl).toBe('https://github.example/donkey/pull/3');
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'created',
      prUrl: 'https://github.example/donkey/pull/3',
      approvedBy: 'test',
      failureStage: null,
      lastError: null,
    });
    expect(await repositories.listAuditEvents('run_1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delivery.pr.created' }),
      ]),
    );
    db.close();
  });

  it('pushes an existing delivery branch without checking it out', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'donkey-scm-existing-'));
    tempDirs.push(outputDir);
    execFileSync('git', ['branch', 'donkey-delivery/run_1'], {
      cwd: repoPath,
    });
    const stdoutPath = join(outputDir, 'gh-pr.stdout.log');
    writeFileSync(stdoutPath, 'https://github.example/donkey/pull/4\n', 'utf8');
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        return executed(
          input.command.tool === 'gh'
            ? stdoutPath
            : join(outputDir, `${calls.length}.stdout.log`),
          join(outputDir, `${calls.length}.stderr.log`),
        );
      },
    };

    const result = await createScmDelivery({
      repoPath,
      gateway,
      outputDir,
    }).createPr({
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      branch: 'donkey-delivery/run_1',
      dryRun: false,
      humanApproved: true,
    });

    expect(result.prUrl).toBe('https://github.example/donkey/pull/4');
    expect(calls.map((call) => call.command)).toEqual([
      { tool: 'git', args: ['push', '-u', 'origin', 'donkey-delivery/run_1'] },
      {
        tool: 'gh',
        args: [
          'pr',
          'create',
          '--title',
          'Phase 3 delivery',
          '--body',
          'Evidence body',
          '--head',
          'donkey-delivery/run_1',
          '--base',
          'main',
        ],
      },
    ]);
  });

  it('rejects approved PR creation when the main worktree has uncommitted changes', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'donkey-scm-dirty-'));
    tempDirs.push(outputDir);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);

    await expect(
      createScmDelivery({ repoPath, repositories, outputDir }).createPr({
        runId: 'run_1',
        title: 'Phase 3 delivery',
        body: 'Evidence body',
        branch: 'donkey-delivery/run_1',
        dryRun: false,
        humanApproved: true,
      }),
    ).rejects.toThrow('requires a clean worktree');
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'failed',
      failureStage: 'dirty-worktree',
    });
    db.close();
  });

  it('marks failed delivery stage when PR creation fails after push', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'donkey-scm-fail-logs-'));
    tempDirs.push(outputDir);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const gateway: CommandGateway = {
      async run(input) {
        const fileName = `${input.command.tool}-${input.command.args.join('-').replaceAll('/', '_')}`;
        const stdoutPath = join(outputDir, `${fileName}.out`);
        const stderrPath = join(outputDir, `${fileName}.err`);
        if (input.command.tool === 'gh') {
          return { ...executed(stdoutPath, stderrPath), exitCode: 1 };
        }
        return executed(stdoutPath, stderrPath);
      },
    };

    await expect(
      createScmDelivery({
        repoPath,
        repositories,
        gateway,
        outputDir,
      }).createPr({
        runId: 'run_1',
        title: 'Phase 3 delivery',
        body: 'Evidence body',
        branch: 'donkey/phase-3',
        dryRun: false,
        humanApproved: true,
      }),
    ).rejects.toThrow('delivery command failed');
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'failed',
      failureStage: 'create-pr',
    });
    db.close();
  });

  it('recovers an existing PR URL when gh pr create fails after push', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'donkey-scm-recover-'));
    tempDirs.push(outputDir);
    const db = openDonkeyDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedRun(repositories);
    const viewStdoutPath = join(outputDir, 'gh-pr-view.out');
    writeFileSync(viewStdoutPath, 'https://github.example/donkey/pull/5\n');
    const gateway: CommandGateway = {
      async run(input) {
        const stdoutPath = join(
          outputDir,
          `${input.command.tool}-${input.command.args[0]}.out`,
        );
        const stderrPath = join(
          outputDir,
          `${input.command.tool}-${input.command.args[0]}.err`,
        );
        if (input.command.tool === 'gh' && input.command.args[1] === 'create') {
          return { ...executed(stdoutPath, stderrPath), exitCode: 1 };
        }
        if (input.command.tool === 'gh' && input.command.args[1] === 'view') {
          return executed(viewStdoutPath, stderrPath);
        }
        return executed(stdoutPath, stderrPath);
      },
    };

    const result = await createScmDelivery({
      repoPath,
      repositories,
      audit,
      gateway,
      outputDir,
    }).createPr({
      runId: 'run_1',
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      branch: 'donkey/phase-3',
      dryRun: false,
      humanApproved: true,
    });

    expect(result.prUrl).toBe('https://github.example/donkey/pull/5');
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'created',
      prUrl: 'https://github.example/donkey/pull/5',
      failureStage: null,
    });
    expect(await repositories.listAuditEvents('run_1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delivery.pr.recovered' }),
      ]),
    );
    db.close();
  });
});

function executed(stdoutPath: string, stderrPath: string) {
  writeFileSync(stdoutPath, '', { flag: 'a' });
  writeFileSync(stderrPath, '', { flag: 'a' });
  return {
    status: 'executed' as const,
    exitCode: 0,
    signal: null,
    timedOut: false,
    stdoutPath,
    stderrPath,
    durationMs: 1,
  };
}

async function seedRun(repositories: ReturnType<typeof createRepositories>) {
  await repositories.createDemand({
    id: 'demand_1',
    title: 'Delivery',
    body: 'Create a PR.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'donkey',
    repoPath: '/tmp/donkey',
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
}

function createGitRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'donkey-scm-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'donkey@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Donkey Test'], {
    cwd: repoPath,
  });
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}

function writeFakeGh(
  binDir: string,
  options: { authenticated?: boolean } = {},
) {
  const ghPath = join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env sh
echo "$*" >> "${join(binDir, 'gh.log')}"
if [ "$1 $2" = "auth status" ]; then
  ${
    options.authenticated
      ? 'echo "Logged in to github.example" >&2\n  exit 0'
      : 'echo "not logged in" >&2\n  exit 1'
  }
fi
echo "https://github.example/donkey/pull/1"
`,
    'utf8',
  );
  chmodSync(ghPath, 0o755);
  expect(existsSync(ghPath)).toBe(true);
}
