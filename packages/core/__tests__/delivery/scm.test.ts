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
  DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
  DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS,
  DEFAULT_REAL_PROVIDER_TIMEOUT_MS,
  createAuditLogger,
  createRepositories,
  migrateDatabase,
  openTekonDatabase,
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
      branch: 'tekon/phase-3',
      dryRun: true,
    });

    expect(result.dryRun).toBe(true);
    expect(result.requiresHumanApproval).toBe(true);
    expect(result.commands.map((command) => command.join(' '))).toEqual([
      'git branch tekon/phase-3',
      'git push -u origin tekon/phase-3',
      'gh pr create --title Phase 3 delivery --body Evidence body --head tekon/phase-3 --base main',
    ]);
    expect(
      execFileSync('git', ['status', '--short'], {
        cwd: repoPath,
        encoding: 'utf8',
      }),
    ).toContain('feature.txt');
  }, 15_000);

  it('rejects unsafe delivery branch and base refs before generating commands', async () => {
    const repoPath = createGitRepo(tempDirs);
    const delivery = createScmDelivery({ repoPath });

    for (const branch of [
      '--mirror',
      ':main',
      'feature/../main',
      'feature lock',
      'feature.lock/child',
      'feature//child',
    ]) {
      await expect(
        delivery.createPr({
          title: 'Unsafe branch',
          body: 'Evidence body',
          branch,
          dryRun: true,
        }),
      ).rejects.toThrow('unsafe branch');
    }

    await expect(
      delivery.createPr({
        title: 'Unsafe base',
        body: 'Evidence body',
        branch: 'tekon/safe',
        baseBranch: '--upload-pack=evil',
        dryRun: true,
      }),
    ).rejects.toThrow('unsafe baseBranch');
  });

  it('captures a PR URL from a fake gh fixture after human-approved push', async () => {
    const repoPath = createGitRepo(tempDirs);
    const remotePath = mkdtempSync(join(tmpdir(), 'tekon-remote-'));
    const binDir = mkdtempSync(join(tmpdir(), 'tekon-fake-gh-'));
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
      title: 'Phase 3 <TEKON_OUTPUT_DIR> delivery',
      body: 'Evidence body with `literal` $VALUE',
      branch: 'tekon/phase-3',
      dryRun: false,
      humanApproved: true,
    });

    expect(result.prUrl).toBe('https://github.example/tekon/pull/1');
    expect(result.requiresHumanApproval).toBe(false);
    expect(readFileSync(join(binDir, 'gh.log'), 'utf8')).toContain('pr create');
  });

  it('reports remote, current branch, dirty worktree, auth, and approval requirements', async () => {
    const repoPath = createGitRepo(tempDirs);
    const remotePath = mkdtempSync(join(tmpdir(), 'tekon-remote-'));
    const binDir = mkdtempSync(join(tmpdir(), 'tekon-fake-gh-auth-'));
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

    const status = await delivery.getStatus({ branch: 'tekon/phase-3' });

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

  it('runs SCM status probes through CommandGateway with long-running progress settings', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-status-logs-'));
    tempDirs.push(outputDir);
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        const fileName = `${calls.length}-${input.command.tool}-${input.command.args.join('-').replaceAll('/', '_')}`;
        const stdoutPath = join(outputDir, `${fileName}.out`);
        const stderrPath = join(outputDir, `${fileName}.err`);
        const commandText = `${input.command.tool} ${input.command.args.join(' ')}`;
        if (commandText === 'git remote -v') {
          writeFileSync(
            stdoutPath,
            'origin\thttps://github.example/tekon.git (fetch)\n',
          );
        } else if (commandText === 'git remote get-url origin') {
          writeFileSync(stdoutPath, 'https://github.example/tekon.git\n');
        } else if (commandText === 'git branch --show-current') {
          writeFileSync(stdoutPath, 'main\n');
        } else if (commandText === 'git status --short') {
          writeFileSync(stdoutPath, ' M feature.txt\n');
        } else {
          writeFileSync(stdoutPath, '');
        }
        writeFileSync(stderrPath, '');
        return {
          status: 'executed',
          exitCode: commandText === 'gh auth status' ? 1 : 0,
          signal: null,
          timedOut: false,
          stdoutPath,
          stderrPath,
          progressPath: join(outputDir, `${fileName}.progress.json`),
          durationMs: 1,
        };
      },
    };

    const status = await createScmDelivery({
      repoPath,
      gateway,
      outputDir,
    }).getStatus({ branch: 'tekon/phase-3' });

    expect(status).toMatchObject({
      hasRemote: true,
      remoteName: 'origin',
      remoteUrl: 'https://github.example/tekon.git',
      currentBranch: 'main',
      dirty: true,
      ghAuthenticated: false,
      branchPushed: true,
    });
    expect(calls.map((call) => call.command)).toEqual([
      { tool: 'git', args: ['remote', '-v'] },
      { tool: 'git', args: ['remote', 'get-url', 'origin'] },
      { tool: 'git', args: ['branch', '--show-current'] },
      { tool: 'git', args: ['status', '--short'] },
      { tool: 'gh', args: ['auth', 'status'] },
      {
        tool: 'git',
        args: [
          'ls-remote',
          '--exit-code',
          '--heads',
          'origin',
          'tekon/phase-3',
        ],
      },
    ]);
    expect(
      calls.every(
        (call) =>
          call.timeoutMs === DEFAULT_REAL_PROVIDER_TIMEOUT_MS &&
          call.progressIntervalMs === DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS &&
          call.noProgressTimeoutMs === DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
      ),
    ).toBe(true);
    expect(
      calls.every((call) =>
        call.policy.allow.some(
          (entry) =>
            entry.tool === call.command.tool &&
            entry.match === 'exact' &&
            entry.args.length === call.command.args.length &&
            entry.args.every((arg, index) => arg === call.command.args[index]),
        ),
      ),
    ).toBe(true);
  });

  it('preserves authentication environment for SCM status probes', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-status-env-'));
    tempDirs.push(outputDir);
    const previousGhToken = process.env.GH_TOKEN;
    process.env.GH_TOKEN = 'fixture-token';
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        const stdoutPath = join(outputDir, `${calls.length}.out`);
        const stderrPath = join(outputDir, `${calls.length}.err`);
        writeFileSync(stdoutPath, '');
        writeFileSync(stderrPath, '');
        return {
          status: 'executed',
          exitCode: 0,
          signal: null,
          timedOut: false,
          stdoutPath,
          stderrPath,
          durationMs: 1,
        };
      },
    };

    try {
      await createScmDelivery({ repoPath, gateway, outputDir }).getStatus();
    } finally {
      if (previousGhToken === undefined) {
        delete process.env.GH_TOKEN;
      } else {
        process.env.GH_TOKEN = previousGhToken;
      }
    }

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.envMode === 'exact')).toBe(true);
    expect(calls.every((call) => call.env?.GH_TOKEN === 'fixture-token')).toBe(
      true,
    );
  });

  it('uses CommandGateway argv commands for approved push and PR creation', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-logs-'));
    tempDirs.push(outputDir);
    const stdoutPath = join(outputDir, 'gh-pr.stdout.log');
    writeFileSync(stdoutPath, 'https://github.example/tekon/pull/2\n', 'utf8');
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        const exitCode =
          input.command.tool === 'git' && input.command.args[0] === 'show-ref'
            ? 1
            : 0;
        return {
          status: 'executed',
          exitCode,
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
      branch: 'tekon/phase-3',
      dryRun: false,
      humanApproved: true,
    });

    const writeCalls = deliveryWriteCommandCalls(calls);
    expect(result.prUrl).toBe('https://github.example/tekon/pull/2');
    expect(writeCalls.map((call) => call.command)).toEqual([
      { tool: 'git', args: ['branch', 'tekon/phase-3'] },
      { tool: 'git', args: ['push', '-u', 'origin', 'tekon/phase-3'] },
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
          'tekon/phase-3',
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
    expect(
      writeCalls.every((call) =>
        call.policy.allow.some(
          (entry) =>
            entry.match === 'exact' &&
            entry.tool === call.command.tool &&
            entry.args.length === call.command.args.length &&
            entry.args.every(
              (arg, argIndex) => arg === call.command.args[argIndex],
            ),
        ),
      ),
    ).toBe(true);
    expect(
      calls.every(
        (call) =>
          call.timeoutMs === DEFAULT_REAL_PROVIDER_TIMEOUT_MS &&
          call.progressIntervalMs === DEFAULT_COMMAND_PROGRESS_HEARTBEAT_MS &&
          call.noProgressTimeoutMs === DEFAULT_COMMAND_NO_PROGRESS_TIMEOUT_MS,
      ),
    ).toBe(true);
  }, 15_000);

  it('records awaiting approval before remote PR side effects', async () => {
    const repoPath = createGitRepo(tempDirs);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);

    const delivery = createScmDelivery({ repoPath, repositories });
    const result = await delivery.createPr({
      runId: 'run_1',
      title: 'Phase 3 delivery',
      body: 'Evidence body',
      bodyPath: '.tekon/runs/run_1/delivery/pr-body.md',
      branch: 'tekon/phase-3',
      baseBranch: 'main',
      dryRun: false,
    });

    expect(result.requiresHumanApproval).toBe(true);
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'awaiting-approval',
      branch: 'tekon/phase-3',
      baseBranch: 'main',
      bodyPath: '.tekon/runs/run_1/delivery/pr-body.md',
    });
    db.close();
  });

  it('persists PR URL and audit event after approved creation', async () => {
    const repoPath = createGitRepo(tempDirs);
    const remotePath = mkdtempSync(join(tmpdir(), 'tekon-remote-'));
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-logs-'));
    tempDirs.push(remotePath, outputDir);
    execFileSync('git', ['init', '--bare'], { cwd: remotePath });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: repoPath,
    });
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');
    execFileSync('git', ['add', 'feature.txt'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'feature'], { cwd: repoPath });
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedRun(repositories);

    const stdoutPath = join(outputDir, 'gh-pr.stdout.log');
    writeFileSync(stdoutPath, 'https://github.example/tekon/pull/3\n', 'utf8');
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
      branch: 'tekon/phase-3',
      dryRun: false,
      humanApproved: true,
      approvedBy: 'test',
    });

    expect(result.prUrl).toBe('https://github.example/tekon/pull/3');
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'created',
      prUrl: 'https://github.example/tekon/pull/3',
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
  }, 15_000);

  it('persists timeout reason and progress path when approved PR creation times out', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-timeout-'));
    tempDirs.push(outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedRun(repositories);
    const progressPath = join(outputDir, 'git-push.progress.json');
    const gateway: CommandGateway = {
      async run(input) {
        if (input.command.tool === 'git' && input.command.args[0] === 'push') {
          return {
            status: 'executed',
            exitCode: null,
            signal: 'SIGKILL',
            timedOut: true,
            timeoutReason: 'no-progress',
            stdoutPath: join(outputDir, 'push.stdout.log'),
            stderrPath: join(outputDir, 'push.stderr.log'),
            progressPath,
            durationMs: 1,
          };
        }
        return executed(
          join(outputDir, `${input.command.tool}-${input.command.args[0]}.out`),
          join(outputDir, `${input.command.tool}-${input.command.args[0]}.err`),
        );
      },
    };

    await expect(
      createScmDelivery({
        repoPath,
        repositories,
        audit,
        gateway,
        outputDir,
      }).createPr({
        runId: 'run_1',
        title: 'Phase 3 delivery',
        body: 'Evidence body',
        branch: 'tekon/phase-3',
        dryRun: false,
        humanApproved: true,
        approvedBy: 'test',
      }),
    ).rejects.toThrow(/timed out.*reason=no-progress.*progress=/u);

    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'failed',
      failureStage: 'push-branch',
      lastError: expect.stringContaining(`progress=${progressPath}`),
    });
    db.close();
  });

  it('fails without write side effects when the local branch probe times out', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-branch-probe-'));
    tempDirs.push(outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const progressPath = join(outputDir, 'show-ref.progress.json');
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        if (
          input.command.tool === 'git' &&
          input.command.args[0] === 'show-ref'
        ) {
          return {
            status: 'executed',
            exitCode: null,
            signal: 'SIGKILL',
            timedOut: true,
            timeoutReason: 'total',
            stdoutPath: join(outputDir, 'show-ref.stdout.log'),
            stderrPath: join(outputDir, 'show-ref.stderr.log'),
            progressPath,
            durationMs: 1,
          };
        }
        return executed(
          join(outputDir, `${calls.length}.stdout.log`),
          join(outputDir, `${calls.length}.stderr.log`),
        );
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
        branch: 'tekon/phase-3',
        dryRun: false,
        humanApproved: true,
      }),
    ).rejects.toThrow(/timed out.*reason=total.*progress=/u);

    expect(deliveryWriteCommands(calls)).toEqual([]);
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'failed',
      failureStage: 'branch-probe',
      lastError: expect.stringContaining(`progress=${progressPath}`),
    });
    db.close();
  });

  it('fails without write side effects when the dirty worktree probe times out', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-dirty-probe-'));
    tempDirs.push(outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const progressPath = join(outputDir, 'status-porcelain.progress.json');
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        if (
          input.command.tool === 'git' &&
          input.command.args[0] === 'show-ref'
        ) {
          return {
            ...executed(
              join(outputDir, 'show-ref.stdout.log'),
              join(outputDir, 'show-ref.stderr.log'),
            ),
            exitCode: 1,
          };
        }
        if (
          input.command.tool === 'git' &&
          input.command.args[0] === 'status' &&
          input.command.args[1] === '--porcelain'
        ) {
          return {
            status: 'executed',
            exitCode: null,
            signal: 'SIGKILL',
            timedOut: true,
            timeoutReason: 'no-progress',
            stdoutPath: join(outputDir, 'status-porcelain.stdout.log'),
            stderrPath: join(outputDir, 'status-porcelain.stderr.log'),
            progressPath,
            durationMs: 1,
          };
        }
        return executed(
          join(outputDir, `${calls.length}.stdout.log`),
          join(outputDir, `${calls.length}.stderr.log`),
        );
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
        branch: 'tekon/phase-3',
        dryRun: false,
        humanApproved: true,
      }),
    ).rejects.toThrow(/timed out.*reason=no-progress.*progress=/u);

    expect(deliveryWriteCommands(calls)).toEqual([]);
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'failed',
      failureStage: 'dirty-worktree',
      lastError: expect.stringContaining(`progress=${progressPath}`),
    });
    db.close();
  });

  it('fails without write side effects when the local branch probe is rejected', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-branch-rejected-'));
    tempDirs.push(outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);
    const calls: CommandGatewayRunInput[] = [];
    const gateway: CommandGateway = {
      async run(input) {
        calls.push(input);
        if (
          input.command.tool === 'git' &&
          input.command.args[0] === 'show-ref'
        ) {
          return {
            status: 'rejected',
            reason: 'policy denied branch probe',
          };
        }
        return executed(
          join(outputDir, `${calls.length}.stdout.log`),
          join(outputDir, `${calls.length}.stderr.log`),
        );
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
        branch: 'tekon/phase-3',
        dryRun: false,
        humanApproved: true,
      }),
    ).rejects.toThrow(
      /SCM probe failed: git show-ref .*policy denied branch probe/u,
    );

    expect(deliveryWriteCommands(calls)).toEqual([]);
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'failed',
      failureStage: 'branch-probe',
      lastError: expect.stringContaining('policy denied branch probe'),
    });
    db.close();
  });

  it('pushes an existing delivery branch without checking it out', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-existing-'));
    tempDirs.push(outputDir);
    execFileSync('git', ['branch', 'tekon-delivery/run_1'], {
      cwd: repoPath,
    });
    const stdoutPath = join(outputDir, 'gh-pr.stdout.log');
    writeFileSync(stdoutPath, 'https://github.example/tekon/pull/4\n', 'utf8');
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
      branch: 'tekon-delivery/run_1',
      dryRun: false,
      humanApproved: true,
    });

    expect(result.prUrl).toBe('https://github.example/tekon/pull/4');
    expect(deliveryWriteCommands(calls)).toEqual([
      { tool: 'git', args: ['push', '-u', 'origin', 'tekon-delivery/run_1'] },
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
          'tekon-delivery/run_1',
          '--base',
          'main',
        ],
      },
    ]);
  });

  it('rejects approved PR creation when the main worktree has uncommitted changes', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-dirty-'));
    tempDirs.push(outputDir);
    writeFileSync(join(repoPath, 'feature.txt'), 'feature\n', 'utf8');
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    await seedRun(repositories);

    await expect(
      createScmDelivery({ repoPath, repositories, outputDir }).createPr({
        runId: 'run_1',
        title: 'Phase 3 delivery',
        body: 'Evidence body',
        branch: 'tekon-delivery/run_1',
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
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-fail-logs-'));
    tempDirs.push(outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
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
        branch: 'tekon/phase-3',
        dryRun: false,
        humanApproved: true,
      }),
    ).rejects.toThrow('delivery command failed');
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'failed',
      failureStage: 'create-pr',
    });
    db.close();
  }, 15_000);

  it('recovers an existing PR URL when gh pr create fails after push', async () => {
    const repoPath = createGitRepo(tempDirs);
    const outputDir = mkdtempSync(join(tmpdir(), 'tekon-scm-recover-'));
    tempDirs.push(outputDir);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    await seedRun(repositories);
    const viewStdoutPath = join(outputDir, 'gh-pr-view.out');
    writeFileSync(viewStdoutPath, 'https://github.example/tekon/pull/5\n');
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
      branch: 'tekon/phase-3',
      dryRun: false,
      humanApproved: true,
    });

    expect(result.prUrl).toBe('https://github.example/tekon/pull/5');
    expect(await repositories.getDeliveryPullRequest('run_1')).toMatchObject({
      status: 'created',
      prUrl: 'https://github.example/tekon/pull/5',
      failureStage: null,
    });
    expect(await repositories.listAuditEvents('run_1')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delivery.pr.recovered' }),
      ]),
    );
    db.close();
  }, 15_000);
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

function deliveryWriteCommands(calls: CommandGatewayRunInput[]) {
  return deliveryWriteCommandCalls(calls).map((call) => call.command);
}

function deliveryWriteCommandCalls(calls: CommandGatewayRunInput[]) {
  return calls.filter(
    (call) =>
      (call.command.tool === 'git' &&
        ((call.command.args[0] === 'branch' &&
          call.command.args.length === 2 &&
          !call.command.args[1]?.startsWith('-')) ||
          call.command.args[0] === 'push')) ||
      (call.command.tool === 'gh' &&
        call.command.args[0] === 'pr' &&
        call.command.args[1] === 'create'),
  );
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
    name: 'tekon',
    repoPath: '/tmp/tekon',
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
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-scm-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
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
echo "https://github.example/tekon/pull/1"
`,
    'utf8',
  );
  chmodSync(ghPath, 0o755);
  expect(existsSync(ghPath)).toBe(true);
}
