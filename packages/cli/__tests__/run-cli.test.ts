import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepositories, openDonkeyDatabase } from '@donkey/core';
import { runCli, type CliIO } from '../src/index.js';

describe('runCli in-process', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('covers the local release command surface against one fixture repo', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();

    await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
    expect(io.takeStdout()).toContain('initialized');
    const sessionPath = join(repoPath, '.donkey', 'web-session.json');
    expect(existsSync(sessionPath)).toBe(true);
    expect(JSON.parse(readFileSync(sessionPath, 'utf8'))).toEqual({
      token: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(existsSync(join(repoPath, '.donkey', 'eval'))).toBe(true);

    await expect(
      runCli(
        [
          'run',
          '--dynamic',
          '--dry-run',
          '高风险数据变更需要回滚计划',
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('conditional-high-risk-human-gate');

    await expect(
      runCli(
        [
          'run',
          '给示例模块加批量重试',
          '--template',
          'standard-feature',
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const standardOutput = io.takeStdout();
    const standardRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(
      standardOutput,
    )?.[1];
    expect(standardRunId).toBeTruthy();
    expect(standardOutput).toContain('status=passed');

    await expect(
      runCli(
        [
          'run',
          '修复发布验收中的人工确认路径',
          '--template',
          'bugfix',
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const gatedOutput = io.takeStdout();
    const gatedRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(gatedOutput)?.[1];
    expect(gatedRunId).toBeTruthy();
    expect(gatedOutput).toContain('humanGate=pending');

    await expect(
      runCli(['status', '--run-id', gatedRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('pendingHumanDecisions=1');

    await expect(
      runCli(
        [
          'resume',
          '--run-id',
          gatedRunId!,
          '--approve-human',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('status=passed');

    await expect(
      runCli(
        ['delivery', 'dry-run', '--run-id', standardRunId!, '--repo', repoPath],
        io,
      ),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('requiresHumanApproval=true');

    await expect(
      runCli(
        ['delivery', 'prepare', '--run-id', standardRunId!, '--repo', repoPath],
        io,
      ),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('packagePath=');

    await expect(
      runCli(['review', '--run-id', standardRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    const reviewOutput = io.takeStdout();
    expect(reviewOutput).toContain('## Readiness Failed Checks');
    expect(reviewOutput).toContain('## Artifacts');
    expect(reviewOutput).toContain('## Gate Logs');
    expect(reviewOutput).toContain('## PR Body');
    expect(reviewOutput).toContain('ready=true');

    const evalDir = join(repoPath, '.donkey', 'eval');
    mkdirSync(evalDir, { recursive: true });
    const samplesPath = join(evalDir, 'work-usability-samples.yaml');
    writeFileSync(
      samplesPath,
      [
        'thresholds:',
        '  minSamples: 1',
        '  minReadyRuns: 1',
        '  minRealProviderRuns: 0',
        '  minCreatedPrs: 0',
        '  requireIsolationEvidence: true',
        'samples:',
        '  - id: standard-fixture',
        `    runId: ${standardRunId}`,
      ].join('\n'),
      'utf8',
    );
    await expect(
      runCli(
        [
          'eval',
          'work-usability',
          '--samples',
          samplesPath,
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const usabilityOutput = io.takeStdout();
    expect(usabilityOutput).toContain('usable=true');
    expect(usabilityOutput).toContain('readyRuns=1');
    expect(usabilityOutput).toContain('isolationPassed=1');

    await expect(
      runCli(['pause', '--run-id', gatedRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('status=paused');

    await expect(
      runCli(['cancel', '--run-id', gatedRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('status=cancelled');

    for (const argv of [
      ['role', 'list', '--repo', repoPath],
      ['role', 'show', 'rd', '--repo', repoPath],
      ['role', 'path', 'rd', '--repo', repoPath],
      ['role', 'create', 'qa', '--repo', repoPath],
      ['workflow', 'list', '--repo', repoPath],
      ['workflow', 'show', 'standard-feature', '--repo', repoPath],
      [
        'workflow',
        'create',
        'release-check',
        '--from',
        'bugfix',
        '--repo',
        repoPath,
      ],
      ['constraints', 'show', '--repo', repoPath],
      ['log', '--run-id', gatedRunId!, '--repo', repoPath],
      ['clean', '--repo', repoPath],
    ]) {
      await expect(runCli(argv, io)).resolves.toBe(0);
      expect(io.takeStdout().length).toBeGreaterThan(0);
    }
  }, 15_000);

  it('requires --allow-dirty-base before running on tracked local changes', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();

    await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
    io.takeStdout();
    writeFileSync(
      join(repoPath, 'package.json'),
      readFileSync(join(repoPath, 'package.json'), 'utf8').replace(
        '"name":',
        '"description": "dirty fixture",\n  "name":',
      ),
      'utf8',
    );

    await expect(
      runCli(
        [
          'run',
          '带本地改动的任务',
          '--template',
          'standard-feature',
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain(
      'dirty base worktree requires --allow-dirty-base',
    );

    await expect(
      runCli(
        [
          'run',
          '显式允许本地改动的任务',
          '--template',
          'standard-feature',
          '--agent',
          'mock',
          '--allow-dirty-base',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('status=passed');
  });

  it('does not approve human gates when the run provider snapshot is missing', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();

    await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
    io.takeStdout();
    await expect(
      runCli(
        [
          'run',
          '需要人工确认的旧运行',
          '--template',
          'bugfix',
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const runId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(io.takeStdout())?.[1];
    expect(runId).toBeTruthy();

    const db = openDonkeyDatabase({
      filename: join(repoPath, '.donkey', 'donkey.sqlite'),
    });
    db.prepare('delete from run_provider_configs where run_id = ?').run(runId);
    const repositories = createRepositories(db);

    await expect(
      runCli(
        ['resume', '--run-id', runId!, '--approve-human', '--repo', repoPath],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('has no provider snapshot');
    expect(await repositories.listHumanDecisions(runId!)).toContainEqual(
      expect.objectContaining({ status: 'pending' }),
    );
    db.close();
  });
});

function createMemoryIo(): CliIO & {
  takeStdout(): string;
  takeStderr(): string;
} {
  let stdout = '';
  let stderr = '';
  return {
    stdout: {
      write(chunk) {
        stdout += chunk;
      },
    },
    stderr: {
      write(chunk) {
        stderr += chunk;
      },
    },
    takeStdout() {
      const value = stdout;
      stdout = '';
      return value;
    },
    takeStderr() {
      const value = stderr;
      stderr = '';
      return value;
    },
  };
}

function createFixtureRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'donkey-cli-unit-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'donkey@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Donkey Test'], {
    cwd: repoPath,
  });
  execFileSync('npm', ['init', '-y'], { cwd: repoPath });
  execFileSync(
    'npm',
    ['pkg', 'set', 'scripts.build=node -e "process.exit(0)"'],
    { cwd: repoPath },
  );
  execFileSync(
    'npm',
    ['pkg', 'set', 'scripts.lint=node -e "process.exit(0)"'],
    { cwd: repoPath },
  );
  execFileSync(
    'npm',
    ['pkg', 'set', 'scripts.test=node -e "process.exit(0)"'],
    { cwd: repoPath },
  );
  execFileSync('git', ['add', 'package.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}
