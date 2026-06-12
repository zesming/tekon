import { randomUUID } from 'node:crypto';

import type { TekonRepositories } from '../db/repositories.js';
import type { HumanDecision } from '../types/domain.js';

export interface HumanGate {
  requestHumanGate(input: {
    runId: string;
    nodeId: string;
    gateResultId?: string | null;
    note?: string;
  }): Promise<HumanDecision>;
  approveHumanGate(
    decisionId: string,
    actor: string,
    note?: string,
  ): Promise<HumanDecision>;
  rejectHumanGate(
    decisionId: string,
    actor: string,
    note?: string,
  ): Promise<HumanDecision>;
}

export function createHumanGate(options: {
  repositories: TekonRepositories;
}): HumanGate {
  return {
    async requestHumanGate(input) {
      const decision = await options.repositories.createHumanDecision({
        id: `decision_${randomUUID()}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateResultId: input.gateResultId ?? null,
        status: 'pending',
        note: input.note ?? null,
        createdAt: new Date().toISOString(),
      });
      await options.repositories.transitionNode(input.nodeId, 'paused');
      await options.repositories.updateWorkflowInstanceStatus(
        input.runId,
        'paused',
        input.nodeId,
      );
      return decision;
    },

    async approveHumanGate(decisionId, actor, note) {
      const existing = await options.repositories.getHumanDecision(decisionId);
      if (!existing) {
        throw new Error(`unknown human decision: ${decisionId}`);
      }

      const updated = await options.repositories.updateHumanDecision(
        decisionId,
        {
          status: 'approved',
          actor,
          note: note ?? null,
          decidedAt: new Date().toISOString(),
        },
      );

      if (!updated) {
        throw new Error(`failed to update human decision: ${decisionId}`);
      }

      if (existing.gateResultId) {
        await options.repositories.updateGateResultStatus(
          existing.gateResultId,
          {
            status: 'passed',
            failureClassification: null,
          },
        );
      } else {
        await options.repositories.recordGateResult({
          id: `gate_resume_${decisionId}`,
          runId: existing.runId,
          nodeId: existing.nodeId,
          gateType: 'human',
          status: 'passed',
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      }
      await options.repositories.transitionNode(existing.nodeId, 'running');
      await options.repositories.updateWorkflowInstanceStatus(
        existing.runId,
        'running',
        existing.nodeId,
      );
      return updated;
    },

    async rejectHumanGate(decisionId, actor, note) {
      const existing = await options.repositories.getHumanDecision(decisionId);
      if (!existing) {
        throw new Error(`unknown human decision: ${decisionId}`);
      }

      const updated = await options.repositories.updateHumanDecision(
        decisionId,
        {
          status: 'rejected',
          actor,
          note: note ?? null,
          decidedAt: new Date().toISOString(),
        },
      );

      if (!updated) {
        throw new Error(`failed to update human decision: ${decisionId}`);
      }

      if (existing.gateResultId) {
        await options.repositories.updateGateResultStatus(
          existing.gateResultId,
          {
            status: 'failed',
            failureClassification: 'human-rejected',
          },
        );
      }
      await options.repositories.transitionNode(existing.nodeId, 'blocked');
      await options.repositories.updateWorkflowInstanceStatus(
        existing.runId,
        'blocked',
        existing.nodeId,
      );
      return updated;
    },
  };
}
