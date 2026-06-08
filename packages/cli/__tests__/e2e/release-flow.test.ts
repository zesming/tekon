import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

describe('donkey release flow e2e', () => {
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

  it('executes init -> dynamic dry-run -> template run -> human approval -> delivery dry-run', () => {
    const repoPath = createFixtureRepo(tempDirs);
    const cliPath = join(cliPackageRoot, 'dist', 'index.js');

    expect(runCli(cliPath, ['init', '--repo', repoPath], repoPath)).toContain(
      'initialized',
    );
    expect(
      JSON.parse(
        readFileSync(join(repoPath, '.donkey', 'web-session.json'), 'utf8'),
      ),
    ).toMatchObject({ token: expect.stringMatching(/^[a-f0-9]{64}$/u) });

    const dynamicOutput = runCli(
      cliPath,
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
      repoPath,
    );
    expect(dynamicOutput).toContain('dryRun=true');
    expect(dynamicOutput).toContain('conditional-high-risk-human-gate');

    const standardOutput = runCli(
      cliPath,
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
      repoPath,
    );
    const deliveryRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(
      standardOutput,
    )?.[1];
    expect(deliveryRunId).toBeTruthy();
    expect(standardOutput).toContain('status=passed');

    const gatedOutput = runCli(
      cliPath,
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
      repoPath,
    );
    const gatedRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(gatedOutput)?.[1];
    expect(gatedRunId).toBeTruthy();
    expect(gatedOutput).toContain('humanGate=pending');

    const approveOutput = runCli(
      cliPath,
      [
        'resume',
        '--run-id',
        gatedRunId!,
        '--approve-human',
        '--repo',
        repoPath,
      ],
      repoPath,
    );
    expect(approveOutput).toContain(`runId=${gatedRunId}`);
    expect(approveOutput).toContain('status=passed');

    const deliveryOutput = runCli(
      cliPath,
      ['delivery', 'dry-run', '--run-id', deliveryRunId!, '--repo', repoPath],
      repoPath,
    );
    expect(deliveryOutput).toContain(`runId=${deliveryRunId}`);
    expect(deliveryOutput).toContain('workflowStatus=passed');
    expect(deliveryOutput).toContain('prDryRun=true');
    expect(deliveryOutput).toContain('requiresHumanApproval=true');

    const prepareOutput = runCli(
      cliPath,
      ['delivery', 'prepare', '--run-id', deliveryRunId!, '--repo', repoPath],
      repoPath,
    );
    expect(prepareOutput).toContain(`runId=${deliveryRunId}`);
    expect(prepareOutput).toContain('branch=donkey/');
    expect(prepareOutput).toContain('requiresHumanApproval=true');
    expect(
      existsSync(join(repoPath, '.donkey', 'runs', deliveryRunId!, 'delivery')),
    ).toBe(true);
    expect(
      runCli(
        cliPath,
        ['eval', 'readiness', '--run-id', deliveryRunId!, '--repo', repoPath],
        repoPath,
      ),
    ).toContain('ready=true');
    expect(existsSync(join(repoPath, '.donkey', 'donkey.sqlite'))).toBe(true);
  });
});

function runCli(cliPath: string, args: string[], cwd: string): string {
  return execFileSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
  });
}

function createFixtureRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'donkey-release-e2e-'));
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
