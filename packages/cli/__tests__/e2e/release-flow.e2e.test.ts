import { execFileSync, spawnSync } from 'node:child_process';
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
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

describe('tekon release flow e2e', { timeout: 90_000 }, () => {
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
      '项目初始化完成',
    );
    expect(
      JSON.parse(
        readFileSync(join(repoPath, '.tekon', 'web-session.json'), 'utf8'),
      ),
    ).toMatchObject({ token: expect.stringMatching(/^[a-f0-9]{64}$/u) });
    const preflightOutput = runCli(
      cliPath,
      ['workflow', 'preflight', 'standard-feature', '--repo', repoPath],
      repoPath,
    );
    expect(preflightOutput).toContain('gate=build commandRef=build');
    expect(preflightOutput).toContain('command=npm run build');

    const workflowSelectionOutput = runCli(
      cliPath,
      [
        'workflow',
        'select',
        '补齐 CLI 的单元测试覆盖，要求 test 通过。',
        '--repo',
        repoPath,
      ],
      repoPath,
    );
    expect(workflowSelectionOutput).toContain(
      'recommendedTemplate=test-improvement',
    );
    const workflowSelectionEvalOutput = runCli(
      cliPath,
      [
        'eval',
        'workflow-selection',
        '补齐 CLI 的单元测试覆盖，要求 test 通过。',
        '--template',
        'test-improvement',
      ],
      repoPath,
    );
    expect(workflowSelectionEvalOutput).toContain('ready=true');

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
        'standard-delivery',
        '--agent',
        'mock',
        '--repo',
        repoPath,
      ],
      repoPath,
    );
    const deliveryRunId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(
      standardOutput,
    )?.[1];
    expect(deliveryRunId).toBeTruthy();
    expect(standardOutput).toContain('状态: passed');
    // PD-21：运行结束即输出与 review surface 同源的交付指引，可交付运行
    // 直接给出 prepare 下一步。
    expect(standardOutput).toContain('交付指引:');
    expect(standardOutput).toContain('tekon delivery prepare');

    // CD-23：bugfix 模板在人工门禁暂停，退出码为 3 而非 0。
    const gatedResult = runCliResult(
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
    expect(gatedResult.status, gatedResult.stdout + gatedResult.stderr).toBe(3);
    const gatedOutput = gatedResult.stdout;
    const gatedRunId = /Run ID:\s+(run_[a-zA-Z0-9-]+)/u.exec(gatedOutput)?.[1];
    expect(gatedRunId).toBeTruthy();
    expect(gatedOutput).toContain('人工确认: pending');
    // PD-21：暂停中的运行同样输出指引块，并明示当前不可进入 PR 准备。
    expect(gatedOutput).toContain('交付指引:');
    expect(gatedOutput).toContain('当前不可进入 PR 准备');

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

    // PD-21/T1：bugfix 是自带 delivery 声明的可交付模板，审批通过后
    // 按自身声明裁决即可 prepare，不再被 standard-delivery 专属项挡红。
    const bugfixPrepareOutput = runCli(
      cliPath,
      ['delivery', 'prepare', '--run-id', gatedRunId!, '--repo', repoPath],
      repoPath,
    );
    expect(bugfixPrepareOutput).toContain(`runId=${gatedRunId}`);
    expect(bugfixPrepareOutput).toContain('branch=tekon-delivery/');
    expect(bugfixPrepareOutput).toContain('交付指引:');
    expect(bugfixPrepareOutput).toContain('下一步:');

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
    expect(prepareOutput).toContain('branch=tekon-delivery/');
    expect(prepareOutput).toContain('requiresHumanApproval=true');
    // PD-21：prepare 后指引块含分支/落点/下一步与本地合入提示。
    expect(prepareOutput).toContain('交付指引:');
    expect(prepareOutput).toContain('交付分支: tekon-delivery/');
    expect(prepareOutput).toContain('PR 包:');
    expect(prepareOutput).toContain('PR Body:');
    expect(prepareOutput).toContain('下一步:');
    expect(prepareOutput).toContain(
      `git merge tekon-delivery/${deliveryRunId}`,
    );
    expect(
      existsSync(join(repoPath, '.tekon', 'runs', deliveryRunId!, 'delivery')),
    ).toBe(true);

    const createPendingOutput = runCli(
      cliPath,
      ['delivery', 'create-pr', '--run-id', deliveryRunId!, '--repo', repoPath],
      repoPath,
    );
    expect(createPendingOutput).toContain('deliveryStatus=awaiting-approval');
    expect(createPendingOutput).toContain('requiresHumanApproval=true');

    const remotePath = mkdtempSync(join(tmpdir(), 'tekon-release-remote-'));
    const binDir = mkdtempSync(join(tmpdir(), 'tekon-release-gh-'));
    tempDirs.push(remotePath, binDir);
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: remotePath });
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: repoPath,
    });
    writeFakeGh(binDir);
    const createOutput = runCli(
      cliPath,
      [
        'delivery',
        'create-pr',
        '--run-id',
        deliveryRunId!,
        '--approve-human',
        '--repo',
        repoPath,
      ],
      repoPath,
      { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    );
    expect(createOutput).toContain('deliveryStatus=created');
    expect(createOutput).toContain('requiresHumanApproval=false');
    expect(createOutput).toContain('prUrl=https://github.example/tekon/pull/9');

    const ciWatchOutput = runCli(
      cliPath,
      [
        'delivery',
        'ci-watch',
        '--run-id',
        deliveryRunId!,
        '--max-attempts',
        '1',
        '--interval-ms',
        '0',
        '--repo',
        repoPath,
      ],
      repoPath,
      { PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}` },
    );
    expect(ciWatchOutput).toContain('ciStatus=passed');
    expect(ciWatchOutput).toContain('terminal=true');

    expect(
      runCli(
        cliPath,
        ['eval', 'readiness', '--run-id', deliveryRunId!, '--repo', repoPath],
        repoPath,
      ),
    ).toContain('ready=true');

    const evalDir = join(repoPath, '.tekon', 'eval');
    mkdirSync(evalDir, { recursive: true });
    const recordedSamplesPath = join(evalDir, 'recorded-work-usability.yaml');
    const recordOutput = runCli(
      cliPath,
      [
        'eval',
        'work-usability',
        'record',
        '--run-id',
        deliveryRunId!,
        '--id',
        'recorded-delivery-fixture',
        '--samples',
        recordedSamplesPath,
        '--repo',
        repoPath,
      ],
      repoPath,
    );
    expect(recordOutput).toContain('sampleRecorded=true');
    expect(readFileSync(recordedSamplesPath, 'utf8')).toContain(
      'id: recorded-delivery-fixture',
    );

    const samplesPath = join(evalDir, 'work-usability-samples.yaml');
    writeFileSync(
      samplesPath,
      [
        'thresholds:',
        '  minSamples: 1',
        '  minReadyRuns: 1',
        '  minRealProviderRuns: 0',
        '  minCreatedPrs: 1',
        '  requireIsolationEvidence: true',
        'samples:',
        '  - id: standard-fixture',
        `    runId: ${deliveryRunId}`,
        '    requirePr: true',
        '    expectedPrUrl: https://github.example/tekon/pull/9',
      ].join('\n'),
      'utf8',
    );
    const usabilityOutput = runCli(
      cliPath,
      ['eval', 'work-usability', '--samples', samplesPath, '--repo', repoPath],
      repoPath,
    );
    expect(usabilityOutput).toContain('usable=true');
    expect(usabilityOutput).toContain('createdPrs=1');
    expect(usabilityOutput).toContain('isolationPassed=1');

    const reportMd = join(repoPath, 'docs', 'reviews', 'fixture-usability.md');
    const reportHtml = join(
      repoPath,
      'docs',
      'reviews',
      'fixture-usability.html',
    );
    const reportOutput = runCli(
      cliPath,
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
        'Fixture Usability',
        '--repo',
        repoPath,
      ],
      repoPath,
    );
    expect(reportOutput).toContain(`reportMd=${reportMd}`);
    expect(readFileSync(reportMd, 'utf8')).toContain('# Fixture Usability');
    expect(readFileSync(reportHtml, 'utf8')).toContain('Fixture Usability');
    expect(existsSync(join(repoPath, '.tekon', 'tekon.sqlite'))).toBe(true);
    // Real subprocess init→run→delivery flow; 30s was too tight under parallel
    // test-suite load (observed 34s). Match the describe-level 90s headroom.
  }, 90_000);
});

function runCliResult(
  cliPath: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(env ?? {}) },
  });
}

function runCli(
  cliPath: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): string {
  const result = runCliResult(cliPath, args, cwd, env);
  if (result.status !== 0) {
    throw new Error(
      `tekon ${args.join(' ')} exited with ${result.status}:\n${result.stdout}${result.stderr}`,
    );
  }
  return result.stdout;
}

function createFixtureRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-release-e2e-'));
  tempDirs.push(repoPath);
  // 显式 -b main：runner 无 init.defaultBranch 全局配置时裸 init 会落到
  // master，导致 baseBranchForRepo 回退的 main ref 解析失败（PD-21 的
  // git merge 门控断言在 CI 上拦截了该环境依赖）。
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  writeFileSync(
    join(repoPath, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      version: '1.0.0',
      main: 'index.js',
      scripts: {
        build: 'node -e "process.exit(0)"',
        lint: 'node -e "process.exit(0)"',
        test: 'node -e "process.exit(0)"',
      },
      keywords: [],
      author: '',
      license: 'ISC',
      description: '',
    }),
  );
  execFileSync('git', ['add', 'package.json'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}

function writeFakeGh(binDir: string) {
  const ghPath = join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env sh
echo "$*" >> "${join(binDir, 'gh.log')}"
if [ "$1 $2" = "auth status" ]; then
  echo "Logged in to github.example" >&2
  exit 0
fi
if [ "$1 $2" = "pr checks" ]; then
  printf '[{"name":"build","bucket":"pass","state":"SUCCESS","workflow":"CI"}]\\n'
  exit 0
fi
echo "https://github.example/tekon/pull/9"
`,
    'utf8',
  );
  chmodSync(ghPath, 0o755);
}
