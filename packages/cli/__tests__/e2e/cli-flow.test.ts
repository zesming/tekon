import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

describe('tekon cli e2e', () => {
  const tempDirs: string[] = [];
  const cliPackageRoot = join(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('runs init -> bugfix mock -> status -> log -> clean against persisted state', () => {
    const repoPath = createFixtureRepo(tempDirs);
    const cliPath = join(cliPackageRoot, 'dist', 'index.js');

    const initOutput = runCli(cliPath, ['init', '--repo', repoPath], repoPath);
    expect(initOutput).toContain('initialized');
    expect(existsSync(join(repoPath, '.tekon', 'config.yaml'))).toBe(true);
    expect(existsSync(join(repoPath, '.tekon', 'tekon.sqlite'))).toBe(true);
    expect(existsSync(join(repoPath, '.tekon', 'web-session.json'))).toBe(true);
    expect(existsSync(join(repoPath, '.tekon', 'repo-profile.yaml'))).toBe(
      true,
    );

    const standardRunOutput = runCli(
      cliPath,
      [
        'run',
        '给示例模块加批量重试',
        '--template',
        'standard-delivery',
        '--agent',
        'mock',
        '--repo',
        repoPath,
      ],
      repoPath,
    );
    const standardRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(
      standardRunOutput,
    )?.[1];
    expect(standardRunId).toBeTruthy();
    expect(standardRunOutput).toContain('status=passed');
    expect(
      existsSync(join(repoPath, '.tekon', 'runs', standardRunId!, 'artifacts')),
    ).toBe(true);

    const dynamicOutput = runCli(
      cliPath,
      [
        'run',
        '--dynamic',
        '--dry-run',
        '给支付模块加退款功能，属于高风险数据变更',
        '--agent',
        'mock',
        '--repo',
        repoPath,
      ],
      repoPath,
    );
    expect(dynamicOutput).toContain('dryRun=true');
    expect(dynamicOutput).toContain('conditional-high-risk-human-gate');
    expect(dynamicOutput).toContain('conditional-rollback-plan');

    const runOutput = runCli(
      cliPath,
      [
        'run',
        '修复登录失败后的重试提示',
        '--template',
        'bugfix',
        '--agent',
        'mock',
        '--repo',
        repoPath,
      ],
      repoPath,
    );
    const runId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(runOutput)?.[1];
    expect(runId).toBeTruthy();
    expect(runOutput).toContain('status=paused');
    expect(runOutput).toContain('humanGate=pending');
    expect(existsSync(join(repoPath, '.tekon', 'runs', runId!))).toBe(true);

    const statusOutput = runCli(
      cliPath,
      ['status', '--run-id', runId!, '--repo', repoPath],
      repoPath,
    );
    expect(statusOutput).toContain(`runId=${runId}`);
    expect(statusOutput).toContain('status=paused');
    expect(statusOutput).toContain('pendingHumanDecisions=1');

    const deliveryOutput = runCli(
      cliPath,
      ['delivery', 'dry-run', '--run-id', standardRunId!, '--repo', repoPath],
      repoPath,
    );
    expect(deliveryOutput).toContain(`runId=${standardRunId}`);
    expect(deliveryOutput).toContain('prDryRun=true');
    expect(deliveryOutput).toContain('requiresHumanApproval=true');

    const prepareOutput = runCli(
      cliPath,
      ['delivery', 'prepare', '--run-id', standardRunId!, '--repo', repoPath],
      repoPath,
    );
    expect(prepareOutput).toContain(`runId=${standardRunId}`);
    expect(prepareOutput).toContain('packagePath=');
    expect(prepareOutput).toContain('prBodyPath=');
    expect(prepareOutput).toContain('requiresHumanApproval=true');

    const readinessOutput = runCli(
      cliPath,
      ['eval', 'readiness', '--run-id', standardRunId!, '--repo', repoPath],
      repoPath,
    );
    expect(readinessOutput).toContain(`runId=${standardRunId}`);
    expect(readinessOutput).toContain('ready=false');
    expect(readinessOutput).toContain('failed=pr-created,remote-ci-passed');

    const logOutput = runCli(
      cliPath,
      ['log', '--run-id', runId!, '--repo', repoPath],
      repoPath,
    );
    expect(logOutput).toContain('run.started');
    expect(logOutput).toContain('human.gate.pending');

    const resumeOutput = runCli(
      cliPath,
      ['resume', '--run-id', runId!, '--approve-human', '--repo', repoPath],
      repoPath,
    );
    expect(resumeOutput).toContain(`runId=${runId}`);
    expect(resumeOutput).toContain('status=passed');

    const pauseOutput = runCli(
      cliPath,
      ['pause', '--run-id', runId!, '--repo', repoPath],
      repoPath,
    );
    expect(pauseOutput).toContain('status=paused');

    const cancelOutput = runCli(
      cliPath,
      ['cancel', '--run-id', runId!, '--repo', repoPath],
      repoPath,
    );
    expect(cancelOutput).toContain('status=cancelled');

    expect(
      runCli(cliPath, ['role', 'list', '--repo', repoPath], repoPath),
    ).toContain('reviewer');
    expect(
      runCli(cliPath, ['role', 'show', 'rd', '--repo', repoPath], repoPath),
    ).toContain('Research and Development');
    expect(
      runCli(cliPath, ['role', 'path', 'rd', '--repo', repoPath], repoPath),
    ).toContain('roles/rd');
    expect(
      runCli(cliPath, ['role', 'create', 'qa', '--repo', repoPath], repoPath),
    ).toContain('.tekon/roles/qa');

    expect(
      runCli(cliPath, ['workflow', 'list', '--repo', repoPath], repoPath),
    ).toContain('bugfix');
    expect(
      runCli(
        cliPath,
        ['workflow', 'show', 'standard-feature', '--repo', repoPath],
        repoPath,
      ),
    ).toContain('standard-feature');
    expect(
      runCli(
        cliPath,
        [
          'workflow',
          'create',
          'custom-bugfix',
          '--from',
          'bugfix',
          '--repo',
          repoPath,
        ],
        repoPath,
      ),
    ).toContain('.tekon/workflows/custom-bugfix.yaml');

    expect(
      runCli(cliPath, ['constraints', 'show', '--repo', repoPath], repoPath),
    ).toContain('hard-code-build-lint');

    const cleanOutput = runCli(
      cliPath,
      ['clean', '--repo', repoPath],
      repoPath,
    );
    expect(cleanOutput).toContain('cleaned worktrees=0');
    expect(
      readFileSync(join(repoPath, '.tekon', 'config.yaml'), 'utf8'),
    ).toContain('repoPath');
  }, 30_000);
});

function runCli(cliPath: string, args: string[], cwd: string): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function createFixtureRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-cli-e2e-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  execFileSync('npm', ['init', '-y'], { cwd: repoPath });
  execFileSync(
    'npm',
    ['pkg', 'set', 'scripts.build=node -e "process.exit(0)"'],
    {
      cwd: repoPath,
    },
  );
  execFileSync(
    'npm',
    ['pkg', 'set', 'scripts.lint=node -e "process.exit(0)"'],
    {
      cwd: repoPath,
    },
  );
  execFileSync(
    'npm',
    ['pkg', 'set', 'scripts.test=node -e "process.exit(0)"'],
    {
      cwd: repoPath,
    },
  );
  execFileSync('git', ['add', 'package.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}
