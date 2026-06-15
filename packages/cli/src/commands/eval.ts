import {
  dirname,
  join,
  resolve,
} from 'node:path';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { parseArgs } from 'node:util';

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  createAuditLogger,
  createHumanApprovalSummary,
  createRepositories,
  evaluateDemandShape,
  evaluateHumanApprovalSummary,
  evaluateWorkReadiness,
  evaluateWorkUsability,
  evaluateWorkflowSelection,
  migrateDatabase,
  readDemandShapeFile,
  renderWorkUsabilityEvaluationReport,
  upsertWorkUsabilitySample,
  workUsabilitySampleSetSchema,
  type WorkUsabilitySample,
  type WorkUsabilitySampleSet,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';
import {
  ensureInitialized,
  openProjectDb,
  withCommandCtx,
} from '../lib/context.js';
import {
  resolveHumanDecisionContext,
  selectLatestRunId,
} from '../lib/db-helpers.js';
import {
  resolveDemandShapePath,
  resolveProjectRepoPath,
} from '../lib/path-utils.js';

export async function commandEval(
  argv: string[],
  io: CliIO,
) {
  const [subcommand, ...rest] = argv;
  if (
    subcommand === 'demand-shape' ||
    subcommand === 'draft-shape'
  ) {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        shape: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const shapeArg =
      args.values.shape ?? args.positionals[0];
    const repoPath = resolveProjectRepoPath(
      args.values.repo,
    );
    if (!shapeArg) {
      await ensureInitialized(repoPath, io);
    }
    const shape = readDemandShapeFile(
      resolveDemandShapePath(repoPath, shapeArg),
    );
    const evaluation = evaluateDemandShape(shape);
    io.stdout.write(
      args.values.json
        ? `${JSON.stringify(evaluation, null, 2)}\n`
        : [
            `draftId=${shape.id}`,
            `ready=${evaluation.ready}`,
            `score=${evaluation.score.toFixed(2)}`,
            `failed=${evaluation.checks
              .filter((check) => !check.passed)
              .map((check) => check.id)
              .join(',')}`,
          ].join(' ') + '\n',
    );
    return;
  }

  if (subcommand === 'workflow-selection') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        shape: { type: 'string' },
        template: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(
      args.values.repo,
    );
    const positionalDemandText = args.positionals
      .join(' ')
      .trim();
    const shapePath = args.values.shape
      ? resolveDemandShapePath(
          repoPath,
          args.values.shape,
        )
      : positionalDemandText
        ? null
        : resolveDemandShapePath(repoPath);
    const shape = shapePath
      ? readDemandShapeFile(shapePath)
      : null;
    const demandText = shape
      ? shape.rawText
      : positionalDemandText;
    const evaluation = evaluateWorkflowSelection({
      text: demandText,
      selectedTemplate:
        args.values.template ??
        shape?.recommendedTemplate,
      ...(shape ? { category: shape.category } : {}),
    });
    io.stdout.write(
      args.values.json
        ? `${JSON.stringify(evaluation, null, 2)}\n`
        : [
            `recommendedTemplate=${evaluation.recommendedTemplate}`,
            `selectedTemplate=${evaluation.selectedTemplate}`,
            `ready=${evaluation.ready}`,
            `score=${evaluation.score.toFixed(2)}`,
            `failed=${evaluation.checks
              .filter((check) => !check.passed)
              .map((check) => check.id)
              .join(',')}`,
          ].join(' ') + '\n',
    );
    return;
  }

  if (subcommand === 'approval-summary') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        'decision-id': { type: 'string' },
        json: { type: 'boolean', default: false },
        'max-chars': { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(
      args.values.repo,
    );
    await ensureInitialized(repoPath, io);
    const maxContentChars = args.values['max-chars']
      ? Number(args.values['max-chars'])
      : 1_200;
    if (
      !Number.isFinite(maxContentChars) ||
      maxContentChars <= 0
    ) {
      throw new Error('--max-chars 必须是正数');
    }
    const db = openProjectDb(repoPath);
    migrateDatabase(db);
    try {
      const repositories = createRepositories(db);
      const { runId, decisionId } =
        await resolveHumanDecisionContext({
          db,
          repositories,
          explicitRunId:
            args.values['run-id'] ?? args.positionals[0],
          explicitDecisionId:
            args.values['decision-id'],
        });
      const explicitCommandDisplay = Boolean(
        args.values.repo ??
          args.values['run-id'] ??
          args.positionals[0] ??
          args.values['decision-id'],
      );
      const audit = createAuditLogger({ repositories });
      const summary =
        await createHumanApprovalSummary({
          repoPath,
          repositories,
          audit,
          runId,
          decisionId,
          maxContentChars,
          commandDisplay: explicitCommandDisplay
            ? 'explicit'
            : 'default',
        });
      const evaluation =
        evaluateHumanApprovalSummary(summary);
      io.stdout.write(
        args.values.json
          ? `${JSON.stringify(evaluation, null, 2)}\n`
          : [
              `runId=${runId}`,
              `decisionId=${summary.decisionId}`,
              `ready=${evaluation.ready}`,
              `score=${evaluation.score.toFixed(2)}`,
              `failed=${evaluation.checks
                .filter((check) => !check.passed)
                .map((check) => check.id)
                .join(',')}`,
            ].join(' ') + '\n',
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand === 'work-usability') {
    if (rest[0] === 'record') {
      await commandWorkUsabilityRecord(
        rest.slice(1),
        io,
      );
      return;
    }
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        samples: { type: 'string' },
        json: { type: 'boolean', default: false },
        'report-md': { type: 'string' },
        'report-html': { type: 'string' },
        title: { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(
      args.values.repo,
    );
    await ensureInitialized(repoPath, io);
    const samplePath = resolve(
      repoPath,
      args.values.samples ??
        join(
          '.tekon',
          'eval',
          'work-usability-samples.yaml',
        ),
    );
    if (!existsSync(samplePath)) {
      throw new Error(
        `未找到工作可用性评估样本文件: ${samplePath}。请先创建该文件或使用 --samples 参数指定正确路径。`,
      );
    }
    const sampleSet = workUsabilitySampleSetSchema.parse(
      parseYaml(readFileSync(samplePath, 'utf8')),
    );
    const db = openProjectDb(repoPath);
    migrateDatabase(db);
    try {
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const evaluation = await evaluateWorkUsability({
        repoPath,
        repositories,
        audit,
        sampleSet,
      });
      const reportMarkdownPath = args.values['report-md']
        ? resolve(
            repoPath,
            args.values['report-md'],
          )
        : null;
      const reportHtmlPath = args.values['report-html']
        ? resolve(
            repoPath,
            args.values['report-html'],
          )
        : null;
      if (reportMarkdownPath || reportHtmlPath) {
        const report =
          renderWorkUsabilityEvaluationReport({
            title:
              args.values.title ??
              'Tekon Work Usability Evaluation',
            generatedAt: new Date().toISOString(),
            samplePath,
            evaluation,
          });
        if (reportMarkdownPath) {
          mkdirSync(
            dirname(reportMarkdownPath),
            { recursive: true },
          );
          writeFileSync(
            reportMarkdownPath,
            report.markdown,
            'utf8',
          );
        }
        if (reportHtmlPath) {
          mkdirSync(dirname(reportHtmlPath), {
            recursive: true,
          });
          writeFileSync(
            reportHtmlPath,
            report.html,
            'utf8',
          );
        }
      }
      io.stdout.write(
        args.values.json
          ? `${JSON.stringify(evaluation, null, 2)}\n`
          : formatWorkUsabilityEvaluation(evaluation, {
              reportMarkdownPath,
              reportHtmlPath,
            }),
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand !== 'readiness') {
    throw new Error(
      `未知的 eval 子命令: ${subcommand ?? ''}。请使用 tekon help eval 查看可用子命令。`,
    );
  }
  await withCommandCtx(
    rest,
    io,
    async ({
      repos: repositories,
      repoPath,
      runId,
    }) => {
      const audit = createAuditLogger({ repositories });
      const evaluation = await evaluateWorkReadiness({
        repositories,
        audit,
        runId,
        repoPath,
      });
      const deliveryPr =
        await repositories.getDeliveryPullRequest(runId);
      io.stdout.write(
        [
          `runId=${runId}`,
          `ready=${evaluation.ready}`,
          `score=${evaluation.score.toFixed(2)}`,
          `prCreated=${deliveryPr?.status === 'created' && Boolean(deliveryPr.prUrl)}`,
          `prUrl=${deliveryPr?.prUrl ?? ''}`,
          `failed=${evaluation.checks
            .filter((check) => !check.passed)
            .map((check) => check.id)
            .join(',')}`,
        ].join(' ') + '\n',
      );
    },
  );
}

async function commandWorkUsabilityRecord(
  argv: string[],
  io: CliIO,
) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      samples: { type: 'string' },
      'run-id': { type: 'string' },
      id: { type: 'string' },
      'draft-type': { type: 'string' },
      'demand-type': { type: 'string' },
      'expected-provider': { type: 'string' },
      'expected-pr-url': { type: 'string' },
      'require-real-provider': {
        type: 'boolean',
        default: false,
      },
      'require-pr': { type: 'boolean', default: false },
      notes: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  await ensureInitialized(repoPath, io);
  const samplePath = resolve(
    repoPath,
    args.values.samples ??
      join('.tekon', 'eval', 'work-usability-samples.yaml'),
  );
  const sampleSet: WorkUsabilitySampleSet = existsSync(
    samplePath,
  )
    ? workUsabilitySampleSetSchema.parse(
        parseYaml(readFileSync(samplePath, 'utf8')),
      )
    : { thresholds: {}, samples: [] };
  const db = openProjectDb(repoPath);
  migrateDatabase(db);
  try {
    const repositories = createRepositories(db);
    const runId =
      args.values['run-id'] ??
      args.positionals[0] ??
      selectLatestRunId(db);
    if (!runId) {
      throw new Error(
        '无法推断运行 ID，请使用 --run-id <runId> 指定',
      );
    }
    const workflow =
      await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`未找到运行: ${runId}`);
    }
    const [providerConfig, deliveryPr] =
      await Promise.all([
        repositories.getRunProviderConfig(runId),
        repositories.getDeliveryPullRequest(runId),
      ]);
    const provider =
      args.values['expected-provider'] ??
      providerConfig?.provider;
    const expectedPrUrl =
      args.values['expected-pr-url'] ??
      deliveryPr?.prUrl ??
      undefined;
    const requireRealProvider =
      args.values['require-real-provider'] ||
      Boolean(provider && provider !== 'mock');
    const requirePr =
      args.values['require-pr'] ||
      Boolean(expectedPrUrl);
    const sample: WorkUsabilitySample = {
      id: args.values.id ?? runId,
      runId,
      ...(args.values['draft-type'] ??
      args.values['demand-type']
        ? {
            demandType: (args.values['draft-type'] ??
              args.values[
                'demand-type'
              ]) as WorkUsabilitySample['demandType'],
          }
        : {}),
      ...(provider
        ? {
            expectedProvider:
              provider as WorkUsabilitySample['expectedProvider'],
          }
        : {}),
      requireRealProvider,
      requirePr,
      ...(expectedPrUrl ? { expectedPrUrl } : {}),
      ...(args.values.notes
        ? { notes: args.values.notes }
        : {}),
    };
    const result = upsertWorkUsabilitySample(
      sampleSet,
      sample,
    );
    mkdirSync(dirname(samplePath), { recursive: true });
    writeFileSync(
      samplePath,
      stringifyYaml(result.sampleSet),
      'utf8',
    );
    io.stdout.write(
      [
        `sampleRecorded=true`,
        `created=${result.created}`,
        `samplePath=${samplePath}`,
        `id=${sample.id}`,
        `runId=${runId}`,
        `expectedProvider=${sample.expectedProvider ?? ''}`,
        `requireRealProvider=${sample.requireRealProvider}`,
        `requirePr=${sample.requirePr}`,
        `expectedPrUrl=${sample.expectedPrUrl ?? ''}`,
      ].join(' ') + '\n',
    );
  } finally {
    db.close();
  }
}

export function formatWorkUsabilityEvaluation(
  evaluation: Awaited<
    ReturnType<typeof evaluateWorkUsability>
  >,
  reports: {
    reportMarkdownPath?: string | null;
    reportHtmlPath?: string | null;
  } = {},
): string {
  const failedThresholds =
    evaluation.thresholdChecks.filter(
      (check) => !check.passed,
    );
  const failedSampleChecks = evaluation.samples.flatMap(
    (sample) =>
      sample.checks
        .filter((check) => !check.passed)
        .map(
          (check) => `${sample.id}:${check.id}`,
        ),
  );
  return (
    [
      `usable=${evaluation.usable}`,
      `score=${evaluation.score.toFixed(2)}`,
      `samples=${evaluation.counts.samples}`,
      `readyRuns=${evaluation.counts.readyRuns}`,
      `realProviderRuns=${evaluation.counts.realProviderRuns}`,
      `createdPrs=${evaluation.counts.createdPrs}`,
      `securityScanPassed=${evaluation.counts.securityScanPassed}`,
      `isolationPassed=${evaluation.counts.isolationPassed}`,
      `failedThresholds=${failedThresholds.map((check) => check.id).join(',')}`,
      `failedSamples=${failedSampleChecks.join(',')}`,
      reports.reportMarkdownPath
        ? `reportMd=${reports.reportMarkdownPath}`
        : '',
      reports.reportHtmlPath
        ? `reportHtml=${reports.reportHtmlPath}`
        : '',
      '',
      '## Threshold Checks',
      ...evaluation.thresholdChecks.map(
        (check) =>
          `- ${check.id}: ${check.passed} ${check.evidence}`,
      ),
      '',
      '## Samples',
      ...evaluation.samples.map((sample) =>
        [
          `- ${sample.id}: runId=${sample.runId} readiness=${sample.readiness?.ready ?? false} provider=${sample.provider ?? 'missing'} prCreated=${sample.prCreated} isolation=${sample.isolationPassed}`,
          ...sample.checks
            .filter((check) => !check.passed)
            .map(
              (check) =>
                `  - failed ${check.id}: ${check.evidence}`,
            ),
        ].join('\n'),
      ),
      '',
    ].join('\n') + '\n'
  );
}
