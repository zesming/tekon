import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

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
          'demand',
          'shape',
          '给 Web dashboard 增加需求塑形入口，要求 e2e 通过。',
          '--write',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const shapeOutput = io.takeStdout();
    expect(shapeOutput).toContain('approved=false');
    expect(shapeOutput).toContain('recommendedTemplate=standard-feature');
    const shapePath = /shapePath=(\S+)/u.exec(shapeOutput)?.[1];
    expect(shapePath).toBeTruthy();

    await expect(
      runCli(
        [
          'run',
          '--demand-file',
          shapePath!,
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('demand file must be approved');

    await expect(
      runCli(['demand', 'approve', shapePath!, '--actor', 'tester'], io),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('approved=true');

    await expect(
      runCli(['eval', 'demand-shape', shapePath!], io),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('ready=true');

    await expect(
      runCli(
        [
          'run',
          '--demand-file',
          shapePath!,
          '--agent',
          'mock',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('status=passed');

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
      runCli(['review', '--run-id', gatedRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    const gatedReviewOutput = io.takeStdout();
    expect(gatedReviewOutput).toContain('## Gate Failure Triage');
    expect(gatedReviewOutput).toContain(
      'classification=human-approval retry=after-approval',
    );
    expect(gatedReviewOutput).toContain(
      `suggestedCommand=donkey resume --run-id ${gatedRunId} --approve-human`,
    );

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
      runCli(
        [
          'delivery',
          'ci-status',
          '--run-id',
          standardRunId!,
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('run has no PR selector for CI status');

    const binDir = mkdtempSync(join(tmpdir(), 'donkey-cli-fake-gh-'));
    tempDirs.push(binDir);
    writeFakeGhChecks(binDir);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${process.env.PATH ? `${delimiter}${process.env.PATH}` : ''}`;
    try {
      await expect(
        runCli(
          [
            'delivery',
            'ci-status',
            '--run-id',
            standardRunId!,
            '--selector',
            'https://github.example/org/repo/pull/1',
            '--repo',
            repoPath,
          ],
          io,
        ),
      ).resolves.toBe(0);
      await expect(
        runCli(
          [
            'delivery',
            'ci-watch',
            '--run-id',
            standardRunId!,
            '--selector',
            'https://github.example/org/repo/pull/1',
            '--max-attempts',
            '1',
            '--interval-ms',
            '0',
            '--repo',
            repoPath,
          ],
          io,
        ),
      ).resolves.toBe(0);
    } finally {
      process.env.PATH = originalPath;
    }
    const ciOutput = io.takeStdout();
    expect(ciOutput).toContain('ciStatus=passed');
    expect(ciOutput).toContain('terminal=true');
    expect(ciOutput).toContain(
      'selector=https://github.example/org/repo/pull/1',
    );

    await expect(
      runCli(['review', '--run-id', standardRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    const reviewOutput = io.takeStdout();
    expect(reviewOutput).toContain('## Readiness Failed Checks');
    expect(reviewOutput).toContain('## Evidence Navigation');
    expect(reviewOutput).toContain('## Gate Failure Triage');
    expect(reviewOutput).toContain('Readiness: pr-created');
    expect(reviewOutput).toContain('## Artifacts');
    expect(reviewOutput).toContain('## Gate Logs');
    expect(reviewOutput).toContain('## PR Body');
    expect(reviewOutput).toContain('ready=true');

    const evalDir = join(repoPath, '.donkey', 'eval');
    mkdirSync(evalDir, { recursive: true });
    const recordedSamplesPath = join(evalDir, 'recorded-work-usability.yaml');
    await expect(
      runCli(
        [
          'eval',
          'work-usability',
          'record',
          '--run-id',
          standardRunId!,
          '--id',
          'recorded-standard-fixture',
          '--samples',
          recordedSamplesPath,
          '--notes',
          'CLI recorded fixture sample.',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const recordOutput = io.takeStdout();
    expect(recordOutput).toContain('sampleRecorded=true');
    expect(recordOutput).toContain('created=true');
    const recordedSamples = readFileSync(recordedSamplesPath, 'utf8');
    expect(recordedSamples).toContain('id: recorded-standard-fixture');
    expect(recordedSamples).toContain(`runId: ${standardRunId}`);
    expect(recordedSamples).toContain('expectedProvider: mock');

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

    const reportMd = join(
      repoPath,
      'docs',
      'reviews',
      'fixture-work-usability.md',
    );
    const reportHtml = join(
      repoPath,
      'docs',
      'reviews',
      'fixture-work-usability.html',
    );
    await expect(
      runCli(
        [
          'eval',
          'work-usability',
          '--samples',
          samplesPath,
          '--report-md',
          reportMd,
          '--report-html',
          reportHtml,
          '--title',
          'Fixture Work Usability',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const reportOutput = io.takeStdout();
    expect(reportOutput).toContain(`reportMd=${reportMd}`);
    expect(reportOutput).toContain(`reportHtml=${reportHtml}`);
    expect(readFileSync(reportMd, 'utf8')).toContain(
      '# Fixture Work Usability',
    );
    expect(readFileSync(reportHtml, 'utf8')).toContain(
      'Fixture Work Usability',
    );

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

  it('prints repo profile fix guidance for missing workflow commands', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-cli-preflight-'));
    tempDirs.push(repoPath);
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({ scripts: { compile: 'tsc -p tsconfig.json' } }),
      'utf8',
    );
    const io = createMemoryIo();

    await expect(
      runCli(
        ['workflow', 'preflight', 'standard-feature', '--repo', repoPath],
        io,
      ),
    ).resolves.toBe(0);

    const output = io.takeStdout();
    expect(output).toContain('gate=build commandRef=build status=missing');
    expect(output).toContain('hint=add commands.build');
    expect(output).toContain(
      `profilePath=${join(repoPath, '.donkey', 'repo-profile.yaml')}`,
    );
    expect(output).toContain('suggestedScript=compile');
    expect(output).toContain('suggestedCommand=npm run compile');
  });

  it('prints explicit notApplicable repo profile commands in workflow preflight', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-cli-preflight-na-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.donkey'), { recursive: true });
    writeFileSync(
      join(repoPath, '.donkey', 'repo-profile.yaml'),
      [
        'version: 1',
        'commands:',
        '  build:',
        '    notApplicable: true',
        '    reason: docs-only',
        '  security:',
        '    notApplicable: true',
        '    reason: no-external-security-script',
        'pr:',
        '  baseBranch: main',
        '  titlePrefix: ""',
        'risks:',
        '  highRiskPaths: []',
        '  requiresHumanApproval: []',
      ].join('\n'),
      'utf8',
    );
    const io = createMemoryIo();

    await expect(
      runCli(
        ['workflow', 'preflight', 'standard-feature', '--repo', repoPath],
        io,
      ),
    ).resolves.toBe(0);

    const output = io.takeStdout();
    expect(output).toContain(
      'gate=build commandRef=build status=not-applicable',
    );
    expect(output).toContain(
      'hint=commands.build is explicitly marked notApplicable',
    );
    expect(output).toContain('notApplicableReason=docs-only');
    expect(output).toContain(
      'gate=security-scan commandRef=security status=resolved command=donkey-builtin security scan',
    );
    expect(output).toContain('notApplicableIgnoredFor=security-scan');
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

function writeFakeGhChecks(binDir: string): void {
  const ghPath = join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env sh
if [ "$1 $2" = "pr checks" ]; then
  printf '[{"name":"build","bucket":"pass","state":"SUCCESS","workflow":"CI"}]\\n'
  exit 0
fi
echo "unexpected gh command: $*" >&2
exit 1
`,
    'utf8',
  );
  chmodSync(ghPath, 0o755);
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
