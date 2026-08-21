import { randomUUID } from 'node:crypto';

import type { TekonRepositories } from '../db/repositories.js';
import type { HumanDecision, WorkflowStatus } from '../types/domain.js';
import { WorkflowTerminalError } from '../workflow/errors.js';

const TERMINAL_WORKFLOW_STATUSES: ReadonlyArray<WorkflowStatus> = [
  'passed',
  'failed',
  'cancelled',
];

/**
 * M8 治理护栏:审批/驳回落库前确认 run 未处于终态,防止已 cancelled/passed/failed
 * 的 run 被 approve(复活为 running)或 reject(穿透为 blocked 后再 resume 复活)。
 * 保护所有调用方(CLI + Web + 其他 core 调用)。
 */
async function assertRunNotTerminal(
  repositories: TekonRepositories,
  runId: string,
): Promise<void> {
  const workflow = await repositories.getWorkflowInstance(runId);
  if (workflow && TERMINAL_WORKFLOW_STATUSES.includes(workflow.status)) {
    throw new WorkflowTerminalError(runId, workflow.status);
  }
}


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
      // M8:终态 run 不可被 approve 复活。
      await assertRunNotTerminal(options.repositories, existing.runId);

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
      // M8:终态 run 不可被 reject 穿透为 blocked(再 resume 复活)。
      await assertRunNotTerminal(options.repositories, existing.runId);

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
