import { randomUUID } from 'node:crypto';

import type {
  ArtifactType,
} from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentAdapter } from '../runtime/agent-adapter.js';
import {
  type ExecutableNode,
  type CheckedTransitionFn,
  gatesWithStableKeys,
} from './workflow-runtime.js';
import type { LeaseService } from './lease-service.js';
import type { WorkflowHelpers } from './helpers.js';
import { assertSuccessfulAgentRun } from './helpers.js';
import type { PromptBuilder } from './prompt-builder.js';
import type { GateRunner } from './gate-runner.js';

export interface NodeExecutorDeps {
  repositories: TekonRepositories;
  audit: AuditLogger;
  adapter: AgentAdapter;
  leaseService: LeaseService;
  helpers: WorkflowHelpers;
  promptBuilder: PromptBuilder;
  gateRunner: GateRunner;
  getCheckedTransition(): CheckedTransitionFn;
}

export interface NodeExecutor {
  executeNode(runId: string, node: ExecutableNode): Promise<boolean>;
  appendPmoNodeCheckpoint(
    runId: string,
    node: ExecutableNode,
  ): Promise<void>;
  hasMissingArtifactDependency(
    runId: string,
    node: ExecutableNode,
  ): Promise<boolean>;
}

export function createNodeExecutor(deps: NodeExecutorDeps): NodeExecutor {
  const {
    repositories,
    audit,
    adapter,
    leaseService,
    helpers,
    promptBuilder,
    gateRunner,
    getCheckedTransition,
  } = deps;

  async function hasMissingArtifactDependency(
    runId: string,
    node: ExecutableNode,
  ): Promise<boolean> {
    for (const input of node.inputs) {
      const artifacts = await repositories.listArtifacts(
        runId,
        input.fromNodeId,
        input.type,
      );
      if (artifacts.length === 0) {
        await audit.append({
          runId,
          type: 'artifact.dependency.missing',
          payload: {
            nodeId: node.id,
            fromNodeId: input.fromNodeId,
            artifactType: input.type,
          },
        });
        return true;
      }
    }
    return false;
  }

  async function executeNode(
    runId: string,
    node: ExecutableNode,
  ): Promise<boolean> {
    const checkedTransitionNode = getCheckedTransition();

    const current = await repositories.getNode(node.id);
    if (!current) {
      throw new Error(`node not found: ${node.id}`);
    }

    const resumableLease = await leaseService.activeExecutionLease(
      runId,
      node.id,
    );
    const completedAgentRun = await helpers.hasCompletedAgentRun(
      runId,
      node.id,
    );
    if (
      Boolean(resumableLease) &&
      current.status === 'running' &&
      !completedAgentRun
    ) {
      await repositories.transitionNode(node.id, 'interrupted');
      await repositories.updateWorkflowInstanceStatus(
        runId,
        'interrupted',
        node.id,
      );
      await audit.append({
        runId,
        type: 'node.stale-running-detected',
        payload: { nodeId: node.id, role: node.role },
      });
      return false;
    }
    const resumeFromGate =
      current.status === 'awaiting-gate' ||
      (Boolean(resumableLease) &&
        ['paused', 'running'].includes(current.status) &&
        completedAgentRun);

    if (resumeFromGate) {
      if (current.status === 'paused') {
        // State machine: paused → running → awaiting-gate
        await repositories.transitionNode(node.id, 'running');
        await repositories.transitionNode(node.id, 'awaiting-gate');
      } else if (current.status === 'running') {
        await repositories.transitionNode(node.id, 'awaiting-gate');
      }
      await repositories.updateWorkflowInstanceStatus(
        runId,
        'running',
        node.id,
      );
      await audit.append({
        runId,
        type: 'node.resumed-at-gates',
        payload: { nodeId: node.id, role: node.role },
      });
    } else {
      const fromStatus =
        current.status === 'interrupted' ||
        current.status === 'needs-revision' ||
        current.status === 'blocked'
          ? current.status
          : 'pending';
      await checkedTransitionNode(
        runId,
        node.id,
        'running',
        'node.transition.checked',
        { fromStatus },
      );
      await repositories.updateWorkflowInstanceStatus(
        runId,
        'running',
        node.id,
      );
      await audit.append({
        runId,
        type: 'node.started',
        payload: { nodeId: node.id, role: node.role },
      });

      try {
        const roleRunId = `role_run_${randomUUID()}`;
        await repositories.createRoleRun({
          id: roleRunId,
          runId,
          nodeId: node.id,
          role: node.role,
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        const lease = await leaseService.createExecutionLease(runId, node);
        let agentSucceeded = false;
        try {
          const agentResult = await adapter.runAgent(
            await helpers.agentInputForLease(
              runId,
              node,
              lease,
              await promptBuilder.buildNodePrompt(runId, node),
            ),
          );
          assertSuccessfulAgentRun(agentResult);
          agentSucceeded = true;
          await repositories.markRoleRunCompleted({
            roleRunId,
            completedAt: new Date().toISOString(),
          });
        } finally {
          if (!agentSucceeded) {
            await repositories.transitionNode(node.id, 'interrupted');
            await repositories.updateWorkflowInstanceStatus(
              runId,
              'interrupted',
              node.id,
            );
            await leaseService
              .finalizeExecutionLease(runId, node.id)
              .catch(() => {});
          }
        }
      } catch (error) {
        await repositories.transitionNode(node.id, 'interrupted');
        await repositories.updateWorkflowInstanceStatus(
          runId,
          'interrupted',
          node.id,
        );
        await audit.append({
          runId,
          type: 'node.interrupted',
          payload: {
            nodeId: node.id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return false;
      }

      await checkedTransitionNode(
        runId,
        node.id,
        'awaiting-gate',
        'node.transition.checked',
      );
    }
    const configuredGates = gatesWithStableKeys(node.gates, node.id);
    try {
      for (const gate of configuredGates) {
        const passed = await gateRunner.runGateWithRepair(
          runId,
          node,
          gate,
        );
        if (!passed) {
          return false;
        }
      }
    } catch (error) {
      await repositories.transitionNode(node.id, 'interrupted');
      await repositories.updateWorkflowInstanceStatus(
        runId,
        'interrupted',
        node.id,
      );
      await audit.append({
        runId,
        type: 'gate.execution.error',
        payload: {
          nodeId: node.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return false;
    }

    try {
      await helpers.recordQaValidationRef(runId, node);
      await leaseService.finalizeExecutionLease(runId, node.id);
    } catch (error) {
      await repositories.transitionNode(node.id, 'interrupted');
      await repositories.updateWorkflowInstanceStatus(
        runId,
        'interrupted',
        node.id,
      );
      await audit.append({
        runId,
        type: 'worktree.lease.finalize.failed',
        payload: {
          nodeId: node.id,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return false;
    }

    await checkedTransitionNode(
      runId,
      node.id,
      'passed',
      'node.passed',
    );
    await appendPmoNodeCheckpoint(runId, node);
    return true;
  }

  async function appendPmoNodeCheckpoint(
    runId: string,
    node: ExecutableNode,
  ): Promise<void> {
    const configuredGates = gatesWithStableKeys(node.gates, node.id);
    const requiredArtifacts = requiredArtifactTypesForNode(node);
    const missingArtifacts: ArtifactType[] = [];
    for (const artifactType of requiredArtifacts) {
      const artifacts = await repositories.listArtifacts(
        runId,
        node.id,
        artifactType,
      );
      if (artifacts.length === 0) {
        missingArtifacts.push(artifactType);
      }
    }
    const gateResults = await repositories.listGateResults(runId);
    await audit.append({
      runId,
      type: 'pmo.node-checkpoint',
      payload: {
        nodeId: node.id,
        role: node.role,
        status: 'passed',
        requiredArtifacts,
        missingArtifacts,
        gateTypes: configuredGates.map((gate) => gate.type),
        gateKeys: configuredGates.map((gate) => gate.gateKey),
        latestGateStatuses: gateRunner.latestGateResultsForNode(
          gateResults,
          node.id,
        ),
      },
    });
  }

  return {
    executeNode,
    appendPmoNodeCheckpoint,
    hasMissingArtifactDependency,
  };
}

function requiredArtifactTypesForNode(input: {
  outputs?: { type: string }[];
  gates?: { type: string; artifactType?: string }[];
}): ArtifactType[] {
  const required = new Set<ArtifactType>();
  for (const output of input.outputs ?? []) {
    required.add(output.type as ArtifactType);
  }
  for (const gate of input.gates ?? []) {
    if (gate.type === 'schema' && gate.artifactType) {
      required.add(gate.artifactType as ArtifactType);
    }
  }
  return [...required];
}
