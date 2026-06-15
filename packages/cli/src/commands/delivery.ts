import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  createAuditLogger,
  createCommandGateway,
  createDeliveryEvidencePackage,
  createPullRequestPreparation,
  createRepositories,
  createScmDelivery,
  migrateDatabase,
  queryPullRequestCiStatus,
  watchPullRequestCiStatus,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';
import {
  ensureInitialized,
  openProjectDb,
  withCommandCtx,
  withProjectContext,
} from '../lib/context.js';
import {
  resolveProjectRepoPath,
} from '../lib/path-utils.js';
import { selectLatestRunId } from '../lib/db-helpers.js';

export async function commandDelivery(
  argv: string[],
  io: CliIO,
) {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'prepare') {
    await withCommandCtx(
      rest,
      io,
      async ({
        repos: repositories,
        repoPath,
        runId,
      }) => {
        const audit = createAuditLogger({ repositories });
        const preparation =
          await createPullRequestPreparation({
            repoPath,
            repositories,
            audit,
            runId,
          });
        io.stdout.write(
          [
            `runId=${runId}`,
            `branch=${preparation.branch}`,
            `baseBranch=${preparation.baseBranch}`,
            `packagePath=${preparation.packagePath}`,
            `prBodyPath=${preparation.prBodyPath}`,
            `requiresHumanApproval=${preparation.requiresHumanApproval}`,
          ].join(' ') + '\n',
        );
      },
    );
    return;
  }

  if (subcommand === 'create-pr') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        'approve-human': {
          type: 'boolean',
          default: false,
        },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(
      args.values.repo,
    );
    await ensureInitialized(repoPath, io);
    await withProjectContext(
      repoPath,
      async ({ db, repos: repositories }) => {
        const runId =
          args.values['run-id'] ??
          args.positionals[0] ??
          selectLatestRunId(db);
        if (!runId) {
          throw new Error(
            '无法推断运行 ID，请使用 --run-id <runId> 指定',
          );
        }
        const audit = createAuditLogger({ repositories });
        const preparation =
          await createPullRequestPreparation({
            repoPath,
            repositories,
            audit,
            runId,
          });
        const body = readFileSync(
          preparation.prBodyPath,
          'utf8',
        );
        const result = await createScmDelivery({
          repoPath,
          repositories,
          audit,
          outputDir: join(
            repoPath,
            '.tekon',
            'runs',
            runId,
            'delivery',
            'scm',
          ),
        }).createPr({
          runId,
          title: preparation.title,
          body,
          bodyPath: preparation.prBodyPath,
          branch: preparation.branch,
          baseBranch: preparation.baseBranch,
          dryRun: false,
          humanApproved: Boolean(
            args.values['approve-human'],
          ),
          approvedBy: 'cli',
        });
        const delivery =
          await repositories.getDeliveryPullRequest(runId);
        const prUrl =
          result.prUrl ?? delivery?.prUrl ?? '';
        io.stdout.write(
          [
            '✅ PR 已创建',
            `   URL:    ${prUrl}`,
            `   分支:   ${preparation.branch} → ${preparation.baseBranch}`,
            `   runId=${runId}`,
            `   deliveryStatus=${delivery?.status ?? 'unknown'}`,
            `   requiresHumanApproval=${result.requiresHumanApproval}`,
            `   prUrl=${prUrl}`,
            `   failureStage=${delivery?.failureStage ?? ''}`,
          ].join('\n') + '\n',
        );
      },
    );
    return;
  }

  if (subcommand === 'ci-status') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        selector: { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(
      args.values.repo,
    );
    await ensureInitialized(repoPath, io);
    const db = openProjectDb(repoPath);
    try {
      migrateDatabase(db);
      const runId =
        args.values['run-id'] ??
        args.positionals[0] ??
        selectLatestRunId(db);
      if (!runId) {
        throw new Error(
          '无法推断运行 ID，请使用 --run-id <runId> 指定',
        );
      }
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const report = await queryPullRequestCiStatus({
        repoPath,
        repositories,
        audit,
        runId,
        selector: args.values.selector,
      });
      io.stdout.write(
        [
          `runId=${runId}`,
          `ciStatus=${report.status}`,
          `checks=${report.checks.length}`,
          `artifactId=${report.artifact.id}`,
          `selector=${report.selector}`,
        ].join(' ') + '\n',
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand === 'ci-watch') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        selector: { type: 'string' },
        'max-attempts': { type: 'string' },
        'interval-ms': { type: 'string' },
        backoff: { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(
      args.values.repo,
    );
    await ensureInitialized(repoPath, io);
    const db = openProjectDb(repoPath);
    try {
      migrateDatabase(db);
      const runId =
        args.values['run-id'] ??
        args.positionals[0] ??
        selectLatestRunId(db);
      if (!runId) {
        throw new Error(
          '无法推断运行 ID，请使用 --run-id <runId> 指定',
        );
      }
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const result = await watchPullRequestCiStatus({
        repoPath,
        repositories,
        audit,
        runId,
        selector: args.values.selector,
        maxAttempts: args.values['max-attempts']
          ? Number(args.values['max-attempts'])
          : undefined,
        intervalMs: args.values['interval-ms']
          ? Number(args.values['interval-ms'])
          : undefined,
        backoffMultiplier: args.values.backoff
          ? Number(args.values.backoff)
          : undefined,
      });
      io.stdout.write(
        [
          `runId=${runId}`,
          `ciStatus=${result.finalStatus}`,
          `terminal=${result.terminal}`,
          `attempts=${result.attempts}`,
          `maxAttempts=${result.maxAttempts}`,
          `checks=${result.finalReport.checks.length}`,
          `artifactId=${result.finalReport.artifact.id}`,
          `selector=${result.selector}`,
        ].join(' ') + '\n',
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand !== 'dry-run') {
    throw new Error(
      `未知的 delivery 子命令: ${subcommand ?? ''}。请使用 tekon help delivery 查看可用子命令。`,
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
      const evidence =
        await createDeliveryEvidencePackage({
          repositories,
          audit,
          runId,
          riskGates: ['human'],
        });
      const pr = await createScmDelivery({
        repoPath,
      }).createPr({
        title: `Tekon delivery ${runId}`,
        body: `Run ${runId} status=${evidence.workflowStatus}`,
        branch: `tekon-delivery/${runId}`,
        dryRun: true,
      });
      io.stdout.write(
        [
          `runId=${runId}`,
          `workflowStatus=${evidence.workflowStatus}`,
          `artifacts=${evidence.artifacts.length}`,
          `prDryRun=${pr.dryRun}`,
          `requiresHumanApproval=${pr.requiresHumanApproval}`,
        ].join(' ') + '\n',
      );
    },
  );
}
