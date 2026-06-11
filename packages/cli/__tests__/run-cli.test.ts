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
import { delimiter, join, relative } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createRepositories, openTekonDatabase } from '@tekon/core';
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
    const sessionPath = join(repoPath, '.tekon', 'web-session.json');
    expect(existsSync(sessionPath)).toBe(true);
    expect(JSON.parse(readFileSync(sessionPath, 'utf8'))).toEqual({
      token: expect.stringMatching(/^[a-f0-9]{64}$/u),
    });
    expect(existsSync(join(repoPath, '.tekon', 'eval'))).toBe(true);

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
          'workflow',
          'select',
          '补齐 CLI 的单元测试覆盖，要求 test 通过。',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('recommendedTemplate=test-improvement');

    await expect(
      runCli(
        [
          'eval',
          'workflow-selection',
          '补齐 CLI 的单元测试覆盖，要求 test 通过。',
          '--template',
          'standard-feature',
        ],
        io,
      ),
    ).resolves.toBe(0);
    const workflowSelectionOutput = io.takeStdout();
    expect(workflowSelectionOutput).toContain('ready=false');
    expect(workflowSelectionOutput).toContain(
      'failed=selected-template-fits-demand',
    );

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
      `suggestedCommand=tekon resume --run-id ${gatedRunId} --approve-human`,
    );

    await expect(
      runCli(
        ['approval', 'summary', '--run-id', gatedRunId!, '--repo', repoPath],
        io,
      ),
    ).resolves.toBe(0);
    const approvalSummaryOutput = io.takeStdout();
    expect(approvalSummaryOutput).toContain('ready=true');
    expect(approvalSummaryOutput).toContain('## 处理入口');
    expect(approvalSummaryOutput).toContain(
      `tekon resume --run-id ${gatedRunId} --approve-human`,
    );
    expect(approvalSummaryOutput).toContain('tekon approval reject');

    await expect(
      runCli(
        [
          'eval',
          'approval-summary',
          '--run-id',
          gatedRunId!,
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain('ready=true');

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
        [
          'run',
          '拒绝一个需要人工确认的变更',
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
    const rejectableOutput = io.takeStdout();
    const rejectableRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(
      rejectableOutput,
    )?.[1];
    expect(rejectableRunId).toBeTruthy();
    await expect(
      runCli(
        [
          'approval',
          'summary',
          '--run-id',
          rejectableRunId!,
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const rejectableSummary = io.takeStdout();
    const decisionId = /decisionId=(decision_[a-zA-Z0-9-]+)/u.exec(
      rejectableSummary,
    )?.[1];
    expect(decisionId).toBeTruthy();
    await expect(
      runCli(
        [
          'approval',
          'reject',
          '--run-id',
          rejectableRunId!,
          '--decision-id',
          decisionId!,
          '--actor',
          'tester',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const rejectOutput = io.takeStdout();
    expect(rejectOutput).toContain('decisionStatus=rejected');
    expect(rejectOutput).toContain('status=blocked');
    await expect(
      runCli(['review', '--run-id', rejectableRunId!, '--repo', repoPath], io),
    ).resolves.toBe(0);
    const rejectedReviewOutput = io.takeStdout();
    expect(rejectedReviewOutput).toContain(
      'classification=human-rejected retry=not-recommended',
    );
    expect(rejectedReviewOutput).toContain('human reviewer rejected');

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

    const binDir = mkdtempSync(join(tmpdir(), 'tekon-cli-fake-gh-'));
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

    const evalDir = join(repoPath, '.tekon', 'eval');
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

    const codexRecordedSamplesPath = join(
      evalDir,
      'recorded-codex-work-usability.yaml',
    );
    await expect(
      runCli(
        [
          'eval',
          'work-usability',
          'record',
          '--run-id',
          standardRunId!,
          '--id',
          'recorded-codex-fixture',
          '--samples',
          codexRecordedSamplesPath,
          '--expected-provider',
          'codex',
          '--require-real-provider',
          '--require-pr',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const codexRecordOutput = io.takeStdout();
    expect(codexRecordOutput).toContain('expectedProvider=codex');
    expect(codexRecordOutput).toContain('requireRealProvider=true');
    expect(codexRecordOutput).toContain('requirePr=true');
    const codexRecordedSamples = readFileSync(codexRecordedSamplesPath, 'utf8');
    expect(codexRecordedSamples).toContain('id: recorded-codex-fixture');
    expect(codexRecordedSamples).toContain('expectedProvider: codex');
    expect(codexRecordedSamples).toContain('requireRealProvider: true');
    expect(codexRecordedSamples).toContain('requirePr: true');

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
      ['workflow', 'show', 'test-improvement', '--repo', repoPath],
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

    await expect(
      runCli(['workflow', 'list', '--repo', repoPath], io),
    ).resolves.toBe(0);
    const workflowListOutput = io.takeStdout();
    expect(workflowListOutput).toContain('test-improvement');
    expect(workflowListOutput).toContain('docs-update');
    expect(workflowListOutput).toContain('plan-only');
  }, 15_000);

  it('infers current repo, latest demand shape, latest run, and pending decision by default', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();
    const originalCwd = process.cwd();

    process.chdir(repoPath);
    try {
      const activeRepoPath = process.cwd();
      await expect(runCli(['init'], io)).resolves.toBe(0);
      expect(io.takeStdout()).toContain(`initialized repo=${activeRepoPath}`);
      const nestedDir = join(activeRepoPath, 'src', 'feature');
      mkdirSync(nestedDir, { recursive: true });
      process.chdir(nestedDir);

      await expect(
        runCli(
          [
            'demand',
            'shape',
            '给 Web dashboard 增加审批摘要展示，要求 e2e 通过。',
          ],
          io,
        ),
      ).resolves.toBe(0);
      const shapeOutput = io.takeStdout();
      expect(shapeOutput).toContain('approved=false');
      const shapePath = /shapePath=(\S+)/u.exec(shapeOutput)?.[1];
      expect(shapePath).toBeTruthy();
      expect(shapePath).toContain(`${activeRepoPath}/.tekon/demands/`);

      await expect(
        runCli(['demand', 'approve', '--actor', 'tester'], io),
      ).resolves.toBe(0);
      expect(io.takeStdout()).toContain('approved=true');

      await expect(runCli(['eval', 'demand-shape'], io)).resolves.toBe(0);
      expect(io.takeStdout()).toContain('ready=true');

      await expect(runCli(['run', '--agent', 'mock'], io)).resolves.toBe(0);
      const standardOutput = io.takeStdout();
      const standardRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(
        standardOutput,
      )?.[1];
      expect(standardRunId).toBeTruthy();
      expect(standardOutput).toContain('status=passed');

      await expect(runCli(['status'], io)).resolves.toBe(0);
      expect(io.takeStdout()).toContain(`runId=${standardRunId}`);

      await expect(runCli(['review'], io)).resolves.toBe(0);
      expect(io.takeStdout()).toContain(`runId=${standardRunId}`);

      await expect(runCli(['delivery', 'prepare'], io)).resolves.toBe(0);
      expect(io.takeStdout()).toContain(`runId=${standardRunId}`);

      await expect(runCli(['eval', 'readiness'], io)).resolves.toBe(0);
      expect(io.takeStdout()).toContain(`runId=${standardRunId}`);

      await expect(
        runCli(
          [
            'run',
            '修复发布验收中的人工确认路径',
            '--template',
            'bugfix',
            '--agent',
            'mock',
          ],
          io,
        ),
      ).resolves.toBe(0);
      const gatedOutput = io.takeStdout();
      const gatedRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(gatedOutput)?.[1];
      expect(gatedRunId).toBeTruthy();
      expect(gatedOutput).toContain('humanGate=pending');

      await expect(runCli(['approval', 'summary'], io)).resolves.toBe(0);
      const approvalSummaryOutput = io.takeStdout();
      expect(approvalSummaryOutput).toContain(`runId=${gatedRunId}`);
      const rejectDecisionId = /decisionId=(decision_[a-zA-Z0-9-]+)/u.exec(
        approvalSummaryOutput,
      )?.[1];
      expect(rejectDecisionId).toBeTruthy();

      await expect(runCli(['eval', 'approval-summary'], io)).resolves.toBe(0);
      expect(io.takeStdout()).toContain(`runId=${gatedRunId}`);

      await expect(
        runCli(
          [
            'approval',
            'reject',
            '--actor',
            'tester',
            '--note',
            '测试拒绝最新待审批项。',
          ],
          io,
        ),
      ).resolves.toBe(0);
      const rejectOutput = io.takeStdout();
      expect(rejectOutput).toContain(`runId=${gatedRunId}`);
      expect(rejectOutput).toContain(`decisionId=${rejectDecisionId}`);
      expect(rejectOutput).toContain('decisionStatus=rejected');

      await expect(
        runCli(
          [
            'run',
            '再次验证人工批准的默认恢复路径',
            '--template',
            'bugfix',
            '--agent',
            'mock',
          ],
          io,
        ),
      ).resolves.toBe(0);
      const resumableOutput = io.takeStdout();
      const resumableRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(
        resumableOutput,
      )?.[1];
      expect(resumableRunId).toBeTruthy();
      expect(resumableOutput).toContain('humanGate=pending');

      await expect(runCli(['resume', '--approve-human'], io)).resolves.toBe(0);
      const resumeOutput = io.takeStdout();
      expect(resumeOutput).toContain(`runId=${resumableRunId}`);
      expect(resumeOutput).toContain('status=passed');

      const samplesPath = join(
        activeRepoPath,
        '.tekon',
        'eval',
        'default-work-usability.yaml',
      );
      await expect(
        runCli(
          ['eval', 'work-usability', 'record', '--samples', samplesPath],
          io,
        ),
      ).resolves.toBe(0);
      expect(io.takeStdout()).toContain(`runId=${resumableRunId}`);
    } finally {
      process.chdir(originalCwd);
    }
  }, 15_000);

  it('resolves explicit shape paths from cwd first and repo root second', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();
    const originalCwd = process.cwd();

    process.chdir(repoPath);
    try {
      const activeRepoPath = process.cwd();
      await expect(runCli(['init'], io)).resolves.toBe(0);
      io.takeStdout();
      await expect(
        runCli(['demand', 'shape', '给示例模块增加审阅入口'], io),
      ).resolves.toBe(0);
      const shapePath = /shapePath=(\S+)/u.exec(io.takeStdout())?.[1];
      expect(shapePath).toBeTruthy();

      const nestedDir = join(activeRepoPath, 'src', 'nested-shape');
      mkdirSync(nestedDir, { recursive: true });
      process.chdir(nestedDir);

      const repoRootRelativeShapePath = relative(activeRepoPath, shapePath!);
      await expect(
        runCli(
          ['eval', 'demand-shape', '--shape', repoRootRelativeShapePath],
          io,
        ),
      ).resolves.toBe(0);
      const repoRootRelativeOutput = io.takeStdout();
      expect(repoRootRelativeOutput).toContain('demandShapeId=');

      const cwdRelativeShapePath = relative(nestedDir, shapePath!);
      await expect(
        runCli(
          ['demand', 'approve', cwdRelativeShapePath, '--actor', 'tester'],
          io,
        ),
      ).resolves.toBe(0);
      expect(io.takeStdout()).toContain('approved=true');
    } finally {
      process.chdir(originalCwd);
    }
  }, 15_000);

  it('does not approve historical demand shapes by default when the latest shape is already approved', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();
    const originalCwd = process.cwd();

    process.chdir(repoPath);
    try {
      await expect(runCli(['init'], io)).resolves.toBe(0);
      io.takeStdout();

      await expect(
        runCli(['demand', 'shape', '旧的未批准需求'], io),
      ).resolves.toBe(0);
      const historicalShapePath = /shapePath=(\S+)/u.exec(io.takeStdout())?.[1];
      expect(historicalShapePath).toBeTruthy();
      const historicalShape = JSON.parse(
        readFileSync(historicalShapePath!, 'utf8'),
      );
      writeFileSync(
        historicalShapePath!,
        `${JSON.stringify(
          { ...historicalShape, createdAt: '2026-01-01T00:00:00.000Z' },
          null,
          2,
        )}\n`,
        'utf8',
      );

      await expect(
        runCli(['demand', 'shape', '最新且已经批准的需求'], io),
      ).resolves.toBe(0);
      const latestShapePath = /shapePath=(\S+)/u.exec(io.takeStdout())?.[1];
      expect(latestShapePath).toBeTruthy();
      await expect(
        runCli(['demand', 'approve', '--shape', latestShapePath!], io),
      ).resolves.toBe(0);
      io.takeStdout();

      await expect(runCli(['demand', 'approve'], io)).resolves.toBe(1);
      expect(io.takeStderr()).toContain(
        'latest demand shape is already approved',
      );
      expect(
        JSON.parse(readFileSync(historicalShapePath!, 'utf8')).approved,
      ).toBe(false);

      await expect(
        runCli(['demand', 'approve', '--shape', historicalShapePath!], io),
      ).resolves.toBe(0);
      expect(io.takeStdout()).toContain('approved=true');
    } finally {
      process.chdir(originalCwd);
    }
  }, 15_000);

  it('prints explicit follow-up commands when repo is passed explicitly', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();

    await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
    io.takeStdout();
    await expect(
      runCli(
        [
          'run',
          '给示例模块增加跨仓库命令提示',
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
    const standardRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(
      io.takeStdout(),
    )?.[1];
    expect(standardRunId).toBeTruthy();

    await expect(runCli(['review', '--repo', repoPath], io)).resolves.toBe(0);
    expect(io.takeStdout()).toContain(
      `tekon status --run-id ${standardRunId} --repo ${repoPath}`,
    );

    await expect(
      runCli(
        [
          'run',
          '需要跨仓库审批摘要',
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
    const gatedRunId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(io.takeStdout())?.[1];
    expect(gatedRunId).toBeTruthy();

    await expect(
      runCli(['approval', 'summary', '--repo', repoPath], io),
    ).resolves.toBe(0);
    const summaryOutput = io.takeStdout();
    expect(summaryOutput).toContain(
      `tekon resume --run-id ${gatedRunId} --approve-human --repo ${repoPath}`,
    );
    expect(summaryOutput).toContain(
      `tekon approval reject --run-id ${gatedRunId}`,
    );
    expect(summaryOutput).toContain(`--repo ${repoPath}`);
  }, 15_000);

  it('keeps cwd-relative demand shape paths working from repo subdirectories', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();
    const originalCwd = process.cwd();

    process.chdir(repoPath);
    try {
      await expect(runCli(['init'], io)).resolves.toBe(0);
      io.takeStdout();
      await expect(
        runCli(['demand', 'shape', '给示例模块增加参数默认值'], io),
      ).resolves.toBe(0);
      const shapePath = /shapePath=(\S+)/u.exec(io.takeStdout())?.[1];
      expect(shapePath).toBeTruthy();
      await expect(runCli(['demand', 'approve', shapePath!], io)).resolves.toBe(
        0,
      );
      io.takeStdout();

      const nestedDir = join(repoPath, 'packages', 'demo');
      mkdirSync(nestedDir, { recursive: true });
      writeFileSync(join(nestedDir, '.gitkeep'), '', 'utf8');
      execFileSync('git', ['add', 'packages/demo/.gitkeep'], { cwd: repoPath });
      execFileSync('git', ['commit', '-m', 'add nested fixture dir'], {
        cwd: repoPath,
      });
      process.chdir(nestedDir);
      const cwdRelativeShapePath = relative(nestedDir, shapePath!);

      await expect(
        runCli(
          ['run', '--demand-file', cwdRelativeShapePath, '--agent', 'mock'],
          io,
        ),
      ).resolves.toBe(0);
      expect(io.takeStdout()).toContain('status=passed');
    } finally {
      process.chdir(originalCwd);
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
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-cli-preflight-'));
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
      `profilePath=${join(repoPath, '.tekon', 'repo-profile.yaml')}`,
    );
    expect(output).toContain('suggestedScript=compile');
    expect(output).toContain('suggestedCommand=npm run compile');
  });

  it('prints explicit notApplicable repo profile commands in workflow preflight', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-cli-preflight-na-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(
      join(repoPath, '.tekon', 'repo-profile.yaml'),
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
      'gate=security-scan commandRef=security status=resolved command=tekon-builtin security scan',
    );
    expect(output).toContain('notApplicableIgnoredFor=security-scan');
  });

  it('requires decision-id when a run has multiple pending human decisions', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const io = createMemoryIo();

    await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
    io.takeStdout();
    await expect(
      runCli(
        [
          'run',
          '需要多审批歧义保护的变更',
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

    const db = openTekonDatabase({
      filename: join(repoPath, '.tekon', 'tekon.sqlite'),
    });
    const repositories = createRepositories(db);
    const [decision] = await repositories.listHumanDecisions(runId!);
    expect(decision).toBeTruthy();
    await repositories.createHumanDecision({
      ...decision!,
      id: 'decision_extra_pending',
      note: 'second pending decision for ambiguity coverage',
      createdAt: '2026-06-09T00:00:00.000Z',
    });
    db.close();

    await expect(
      runCli(
        ['approval', 'summary', '--run-id', runId!, '--repo', repoPath],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('multiple pending human decisions');

    await expect(
      runCli(
        ['approval', 'reject', '--run-id', runId!, '--repo', repoPath],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('multiple pending human decisions');

    await expect(
      runCli(
        ['resume', '--run-id', runId!, '--approve-human', '--repo', repoPath],
        io,
      ),
    ).resolves.toBe(1);
    expect(io.takeStderr()).toContain('multiple pending human decisions');

    await expect(
      runCli(
        [
          'approval',
          'summary',
          '--run-id',
          runId!,
          '--decision-id',
          decision!.id,
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    const explicitSummaryOutput = io.takeStdout();
    expect(explicitSummaryOutput).toContain(`decisionId=${decision!.id}`);
    expect(explicitSummaryOutput).toContain(
      `tekon resume --run-id ${runId} --approve-human --repo ${repoPath}`,
    );

    await expect(
      runCli(
        [
          'resume',
          '--run-id',
          runId!,
          '--decision-id',
          decision!.id,
          '--approve-human',
          '--repo',
          repoPath,
        ],
        io,
      ),
    ).resolves.toBe(0);
    expect(io.takeStdout()).toContain(`runId=${runId}`);

    const afterResumeDb = openTekonDatabase({
      filename: join(repoPath, '.tekon', 'tekon.sqlite'),
    });
    const afterResumeDecisions = await createRepositories(
      afterResumeDb,
    ).listHumanDecisions(runId!);
    expect(afterResumeDecisions).toContainEqual(
      expect.objectContaining({ id: decision!.id, status: 'approved' }),
    );
    expect(afterResumeDecisions).toContainEqual(
      expect.objectContaining({
        id: 'decision_extra_pending',
        status: 'pending',
      }),
    );
    afterResumeDb.close();
  }, 15_000);

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

    const db = openTekonDatabase({
      filename: join(repoPath, '.tekon', 'tekon.sqlite'),
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

  it('starts a Codex provider run and stores a resumable provider snapshot', async () => {
    const repoPath = createFixtureRepo(tempDirs);
    const binDir = mkdtempSync(join(tmpdir(), 'tekon-cli-codex-bin-'));
    tempDirs.push(binDir);
    writeFakeCodex(binDir);
    const originalPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
    const io = createMemoryIo();

    try {
      await expect(runCli(['init', '--repo', repoPath], io)).resolves.toBe(0);
      io.takeStdout();

      await expect(
        runCli(
          [
            'run',
            '补齐 Codex provider 文档 smoke，要求产出真实 provider 快照。',
            '--template',
            'docs-update',
            '--agent',
            'codex',
            '--repo',
            repoPath,
          ],
          io,
        ),
      ).resolves.toBe(0);
      const runOutput = io.takeStdout();
      expect(runOutput).toContain('status=passed');
      const runId = /runId=(run_[a-zA-Z0-9-]+)/u.exec(runOutput)?.[1];
      expect(runId).toBeTruthy();

      const db = openTekonDatabase({
        filename: join(repoPath, '.tekon', 'tekon.sqlite'),
      });
      const provider = await createRepositories(db).getRunProviderConfig(
        runId!,
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
    }
  }, 15_000);
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

function createFixtureRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-cli-unit-'));
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
