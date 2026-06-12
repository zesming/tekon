import { createPullRequestPreparation, createScmDelivery, queryPullRequestCiStatus } from '@tekon/core';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ServerContext, TokenRunInput, DeliveryCreatePrInput, DeliveryCiStatusInput } from '../context.js';
import { assertRunInScope, listArtifacts, listGates, listHumanDecisions, mustGetRun } from '../queries.js';
import { assertSessionToken } from '../common.js';

export function createDeliveryRouter(context: ServerContext) {
  return {
    async prepare(deliveryInput: TokenRunInput) {
      assertSessionToken(context.projectContext, deliveryInput.token);
      assertRunInScope(context.db, context.projectContext, deliveryInput.runId);
      const preparation = await createPullRequestPreparation({
        repoPath: context.projectContext.projectRoot,
        repositories: context.repositories,
        audit: context.audit,
        runId: deliveryInput.runId,
      });
      return {
        runId: deliveryInput.runId,
        branch: preparation.branch,
        baseBranch: preparation.baseBranch,
        packagePath: preparation.packagePath,
        prBodyPath: preparation.prBodyPath,
        requiresHumanApproval: preparation.requiresHumanApproval,
      };
    },

    async createPr(deliveryInput: DeliveryCreatePrInput) {
      assertSessionToken(context.projectContext, deliveryInput.token);
      assertRunInScope(context.db, context.projectContext, deliveryInput.runId);
      const preparation = await createPullRequestPreparation({
        repoPath: context.projectContext.projectRoot,
        repositories: context.repositories,
        audit: context.audit,
        runId: deliveryInput.runId,
      });
      const result = await createScmDelivery({
        repoPath: context.projectContext.projectRoot,
        env: context.projectContext.env,
        repositories: context.repositories,
        audit: context.audit,
        outputDir: join(
          context.projectContext.dataDir,
          'runs',
          deliveryInput.runId,
          'delivery',
          'scm',
        ),
      }).createPr({
        runId: deliveryInput.runId,
        title: preparation.title,
        body: readFileSync(preparation.prBodyPath, 'utf8'),
        bodyPath: preparation.prBodyPath,
        branch: preparation.branch,
        baseBranch: preparation.baseBranch,
        dryRun: false,
        humanApproved: deliveryInput.approveHuman === true,
        approvedBy: 'web',
      });
      const delivery = await context.repositories.getDeliveryPullRequest(
        deliveryInput.runId,
      );
      return {
        runId: deliveryInput.runId,
        deliveryStatus: delivery?.status ?? 'unknown',
        requiresHumanApproval: result.requiresHumanApproval,
        prUrl: result.prUrl ?? delivery?.prUrl ?? null,
        failureStage: delivery?.failureStage ?? null,
        lastError: delivery?.lastError ?? null,
        branch: delivery?.branch ?? null,
        baseBranch: delivery?.baseBranch ?? null,
      };
    },

    async dryRun(deliveryInput: TokenRunInput) {
      assertSessionToken(context.projectContext, deliveryInput.token);
      assertRunInScope(context.db, context.projectContext, deliveryInput.runId);

      // Read-only checks — do NOT call createPullRequestPreparation() here,
      // as it writes artifacts, pr-package.md, pr-body.md, and audit events.
      const run = mustGetRun(context.db, deliveryInput.runId);
      const artifacts = listArtifacts(context.db, deliveryInput.runId);
      const gates = listGates(context.db, deliveryInput.runId);
      const pendingDecisions = listHumanDecisions(
        context.db,
        deliveryInput.runId,
      ).filter((d) => d.status === 'pending');
      const delivery = await context.repositories.getDeliveryPullRequest(
        deliveryInput.runId,
      );

      // Check pre-conditions WITHOUT writing anything
      const workflowPassed = run.status === 'passed';
      const noPendingGates = pendingDecisions.length === 0;
      const allGatesPassed = gates.every(
        (g) => g.status === 'passed' || g.status === 'skipped',
      );

      return {
        runId: deliveryInput.runId,
        workflowStatus: run.status,
        artifacts: artifacts.length,
        gates: {
          total: gates.length,
          passed: gates.filter((g) => g.status === 'passed').length,
        },
        pendingHumanDecisions: pendingDecisions.length,
        deliveryStatus: delivery?.status ?? 'not-prepared',
        readyForPrepare: workflowPassed && noPendingGates && allGatesPassed,
        dryRun: true as const,
      };
    },

    async ciStatus(deliveryInput: DeliveryCiStatusInput) {
      assertSessionToken(context.projectContext, deliveryInput.token);
      assertRunInScope(context.db, context.projectContext, deliveryInput.runId);
      const delivery = await context.repositories.getDeliveryPullRequest(
        deliveryInput.runId,
      );

      if (!delivery?.prUrl && !delivery?.branch) {
        return {
          runId: deliveryInput.runId,
          status: 'no-pr',
          checks: [],
          prUrl: null,
        };
      }

      // Try to query real CI status via core (gh pr checks)
      try {
        const ciResult = await queryPullRequestCiStatus({
          repoPath: context.projectContext.projectRoot,
          repositories: context.repositories,
          audit: context.audit,
          runId: deliveryInput.runId,
          selector: deliveryInput.selector,
          env: context.projectContext.env,
        });

        return {
          runId: deliveryInput.runId,
          status: ciResult.status,
          checks: ciResult.checks.map((c) => ({
            name: c.name,
            state: c.state ?? null,
            bucket: c.bucket ?? null,
            workflow: c.workflow ?? null,
            link: c.link ?? null,
            description: c.description ?? null,
          })),
          prUrl: ciResult.prUrl ?? delivery?.prUrl ?? null,
        };
      } catch (error) {
        // If CI query fails (no gh, no remote, etc.), return DB state
        const fallbackStatus = delivery?.status ?? 'unknown';
        return {
          runId: deliveryInput.runId,
          status: 'query-failed',
          checks: delivery
            ? [
                {
                  name: 'delivery',
                  state: fallbackStatus,
                  bucket: delivery.failureStage ?? null,
                  workflow: null,
                  link: null,
                  description:
                    error instanceof Error ? error.message : String(error),
                },
              ]
            : [],
          prUrl: delivery?.prUrl ?? null,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
