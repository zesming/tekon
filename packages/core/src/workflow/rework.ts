import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

import type { GateResult, Node } from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentAdapter } from '../runtime/agent-adapter.js';
import {
  buildRolePrompt,
  type RolePromptArtifactSummary,
} from '../role/prompt-builder.js';
import { loadRole } from '../role/loader.js';
import {
  type WorkflowArtifactInputRef,
  type WorkflowArtifactOutputRef,
  type WorkflowGateConfig,
} from './template.js';
import {
  type ArtifactStoreLike,
  type CheckedTransitionFn,
  type ExecutableNode,
  type RunGateWithRepairFn,
  defaultBuiltInRolesDir,
  gatesWithStableKeys,
  resolveReviewTargetNodeByHeuristic,
} from './workflow-runtime.js';
import type { LeaseService } from './lease-service.js';
import type { WorkflowHelpers } from './helpers.js';
import { assertSuccessfulAgentRun } from './helpers.js';
import type { PromptBuilder } from './prompt-builder.js';

export interface ReworkHandlerDeps {
  repoPath: string;
  dataDir: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  adapter: AgentAdapter;
  builtInRolesDir?: string;
  userHome?: string;
  leaseService: LeaseService;
  helpers: WorkflowHelpers;
  promptBuilder: PromptBuilder;
  artifactStore: ArtifactStoreLike;
  getCheckedTransition(): CheckedTransitionFn;
  getRunGateWithRepair(): RunGateWithRepairFn;
}

export interface ReworkHandler {
  attemptChangesRequestedRework(
    runId: string,
    reviewNode: ExecutableNode,
    gate: WorkflowGateConfig,
    gateResult: GateResult,
    targetNodeId: string,
    attempt: number,
  ): Promise<void>;
  resolveReviewTargetNode(
    runId: string,
    reviewNodeId: string,
  ): Promise<string | null>;
}

export function createReworkHandler(deps: ReworkHandlerDeps): ReworkHandler {
  const {
    repoPath,
    dataDir,
    repositories,
    audit,
    adapter,
    builtInRolesDir,
    userHome,
    leaseService,
    helpers,
    promptBuilder,
    artifactStore,
    getCheckedTransition,
    getRunGateWithRepair,
  } = deps;

  async function resolveReviewTargetNode(
    runId: string,
    reviewNodeId: string,
  ): Promise<string | null> {
    try {
      const reviewArtifacts = await repositories.listArtifacts(
        runId,
        reviewNodeId,
      );
      const reviewTypes = [
        'technical-review',
        'demand-review',
        'requirement-interface-review',
      ];
      const reviewArtifact = reviewArtifacts.find((a) =>
        reviewTypes.includes(a.type),
      );
      if (reviewArtifact) {
        const artifactPath = resolve(repoPath, reviewArtifact.path);
        if (existsSync(artifactPath)) {
          try {
            const raw = readFileSync(artifactPath, 'utf8');
            const payload = JSON.parse(raw);
            const targetNodeId =
              payload?.reviewProcess?.targetNodeId as string | undefined;
            if (targetNodeId) {
              const targetNode = await repositories.getNode(targetNodeId);
              if (targetNode && targetNode.runId === runId) {
                return targetNodeId;
              }
            }
          } catch {
            // JSON parse failed — fall through to heuristic
          }
        }
      }
    } catch {
      // Fall through to heuristic
    }

    try {
      const nodes = await repositories.listNodes(runId);
      return resolveReviewTargetNodeByHeuristic(nodes, reviewNodeId);
    } catch {
      // Ignore
    }
    return null;
  }

  async function loadReviewArtifactContent(
    runId: string,
    reviewNodeId: string,
  ): Promise<string> {
    try {
      const artifacts = await repositories.listArtifacts(runId, reviewNodeId);
      const reviewArtifact = artifacts.find((a) =>
        [
          'technical-review',
          'demand-review',
          'requirement-interface-review',
        ].includes(a.type),
      );
      if (reviewArtifact?.summary) {
        return reviewArtifact.summary;
      }
    } catch {
      // Fall through to default message
    }
    return 'Review found changes that need to be addressed.';
  }

  async function buildReworkNodePrompt(
    runId: string,
    targetNode: Node,
    targetInputs: WorkflowArtifactInputRef[],
    reviewFeedback: string,
  ): Promise<string> {
    const role = loadRole({
      role: targetNode.role,
      repoPath,
      builtInRolesDir: builtInRolesDir ?? defaultBuiltInRolesDir(),
      userHome,
    });
    const workflow = await helpers.mustGetWorkflow(runId);
    const demand = await helpers.mustGetDemand(workflow.demandId);
    const reworkNodeForArtifacts: ExecutableNode = {
      id: targetNode.id,
      role: targetNode.role,
      phaseId: targetNode.phaseId,
      inputs: targetInputs,
      outputs: (targetNode.outputs ?? []) as WorkflowArtifactOutputRef[],
      gates: (targetNode.gates ?? []) as WorkflowGateConfig[],
      dependsOn: targetNode.dependencies ?? [],
    };
    const artifacts = await artifactSummariesForReworkNode(
      runId,
      reworkNodeForArtifacts,
    );
    const allNodes = await repositories.listNodes(runId);
    const priorNodes = allNodes.filter((n) => n.id !== targetNode.id);
    const priorNodeLines = priorNodes.map((item) =>
      [
        `- ${item.id} role=${item.role} status=${item.status}`,
        item.outputs.length > 0
          ? `outputs=${item.outputs.map((output) => output.type).join(',')}`
          : 'outputs=none',
      ].join(' '),
    );
    const truncated =
      reviewFeedback.length > 8000
        ? reviewFeedback.slice(0, 8000) + '\n\n[truncated]'
        : reviewFeedback;
    return buildRolePrompt({
      role,
      taskInstruction: [
        `Demand title: ${demand.title}`,
        'Demand body:',
        demand.body,
        '',
        `Rework node ${targetNode.id} after independent review found changes-requested.`,
        priorNodeLines.length > 0
          ? ['Prior workflow nodes:', ...priorNodeLines].join('\n')
          : 'Prior workflow nodes: none.',
        '',
        '## Review Feedback',
        truncated,
        '',
        '## Instructions',
        '- Address each finding marked as important or blocker.',
        '- Produce corrected artifact files matching the required types.',
        '- Write the artifact manifest file before completing.',
        '- After writing the manifest, stop work and exit.',
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      projectContext: {
        runId,
        nodeId: targetNode.id,
        projectId: workflow.projectId,
        repoPath,
        dataDir,
      },
      artifactSummaries: artifacts,
    });
  }

  async function artifactSummariesForReworkNode(
    runId: string,
    node: ExecutableNode,
  ): Promise<RolePromptArtifactSummary[]> {
    const summaries: RolePromptArtifactSummary[] = [];
    for (const input of node.inputs) {
      const artifacts = await repositories.listArtifacts(
        runId,
        input.fromNodeId,
        input.type,
      );
      const latestArtifact = artifacts.at(-1);
      if (!latestArtifact) {
        continue;
      }
      summaries.push({
        id: latestArtifact.id,
        type: latestArtifact.type,
        path: latestArtifact.path,
        summary: latestArtifact.summary,
        content: await artifactStore.readArtifactForPrompt(latestArtifact),
      });
    }
    return summaries;
  }

  async function attemptChangesRequestedRework(
    runId: string,
    reviewNode: ExecutableNode,
    gate: WorkflowGateConfig,
    gateResult: GateResult,
    targetNodeId: string,
    attempt: number,
  ): Promise<void> {
    const checkedTransitionNode = getCheckedTransition();
    const runGateWithRepair = getRunGateWithRepair();

    const targetNode = await repositories.getNode(targetNodeId);
    if (!targetNode) return;

    const reworkNodeId = `${targetNodeId}_rework_${attempt}`;

    // --- Step 1: Transition target to needs-revision ---
    await checkedTransitionNode(
      runId,
      targetNodeId,
      'needs-revision',
      'gate.rework.needs-revision',
      {
        reviewNodeId: reviewNode.id,
        targetNodeId,
        gateResultId: gateResult.id,
        attempt,
        reason: 'Independent review found changes-requested',
      },
    );

    const reviewFeedback = await loadReviewArtifactContent(
      runId,
      reviewNode.id,
    );
    const targetInputs = targetNode.inputs as WorkflowArtifactInputRef[];
    const targetOutputs = targetNode.outputs as WorkflowArtifactOutputRef[];
    const targetGates = targetNode.gates as WorkflowGateConfig[];
    const reworkPrompt = await buildReworkNodePrompt(
      runId,
      targetNode,
      targetInputs,
      reviewFeedback,
    );

    await leaseService.finalizeExecutionLease(runId, reviewNode.id);

    // --- Step 2: Create rework node reusing target's inputs/outputs/gates ---
    const now = new Date().toISOString();
    await repositories.createNode({
      id: reworkNodeId,
      runId,
      role: targetNode.role,
      status: 'pending',
      inputs: targetInputs,
      outputs: targetOutputs,
      gates: targetGates,
      dependencies: [reviewNode.id],
      createdAt: now,
      updatedAt: now,
      phaseId: targetNode.phaseId,
    });

    // --- Step 3: Run rework agent ---
    const reworkRoleRunId = `role_run_${randomUUID()}`;
    await repositories.createRoleRun({
      id: reworkRoleRunId,
      runId,
      nodeId: reworkNodeId,
      role: targetNode.role,
      status: 'running',
      startedAt: now,
    });

    await checkedTransitionNode(
      runId,
      reworkNodeId,
      'running',
      'node.transition.checked',
    );

    const reworkLease = await leaseService.createExecutionLease(runId, {
      id: reworkNodeId,
      role: targetNode.role,
      phaseId: targetNode.phaseId,
    });

    try {
      let reworkSucceeded = false;
      try {
        const reworkResult = await adapter.runAgent(
          await helpers.agentInputForLease(
            runId,
            {
              id: reworkNodeId,
              role: targetNode.role,
              phaseId: targetNode.phaseId,
              inputs: targetInputs,
              outputs: targetOutputs,
              gates: targetGates,
            },
            reworkLease,
            reworkPrompt,
            targetNodeId,
          ),
        );
        assertSuccessfulAgentRun(reworkResult);
        reworkSucceeded = true;
        await repositories.markRoleRunCompleted({
          roleRunId: reworkRoleRunId,
          completedAt: new Date().toISOString(),
        });
      } finally {
        if (!reworkSucceeded) {
          await leaseService
            .finalizeExecutionLease(runId, reworkNodeId)
            .catch(() => {});
        }
      }
    } catch (error) {
      await repositories.transitionNode(reworkNodeId, 'interrupted');
      await audit.append({
        runId,
        type: 'gate.rework.failed',
        payload: {
          reviewNodeId: reviewNode.id,
          targetNodeId,
          reworkNodeId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    // --- Step 4: Run target node's gates using targetNodeId ---
    await repositories.transitionNode(reworkNodeId, 'awaiting-gate');
    const configuredTargetGates = gatesWithStableKeys(targetGates, targetNodeId);
    for (const targetGate of configuredTargetGates) {
      const gatePassed = await runGateWithRepair(
        runId,
        {
          id: targetNodeId,
          role: targetNode.role,
          phaseId: targetNode.phaseId,
          inputs: targetInputs,
          outputs: targetOutputs,
          gates: targetGates,
          dependsOn: [reviewNode.id],
        },
        targetGate,
        { forceRerun: true },
      );
      if (!gatePassed) {
        return;
      }
    }

    // --- Step 5: Finalize rework lease ---
    try {
      await leaseService.finalizeExecutionLease(runId, reworkNodeId);
    } catch (error) {
      await repositories.transitionNode(reworkNodeId, 'interrupted');
      await audit.append({
        runId,
        type: 'gate.rework.lease.finalize.failed',
        payload: {
          reviewNodeId: reviewNode.id,
          targetNodeId,
          reworkNodeId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    await checkedTransitionNode(
      runId,
      reworkNodeId,
      'passed',
      'node.transition.checked',
    );
    await checkedTransitionNode(
      runId,
      targetNodeId,
      'running',
      'node.transition.checked',
    );
    await checkedTransitionNode(
      runId,
      targetNodeId,
      'awaiting-gate',
      'node.transition.checked',
    );
    await checkedTransitionNode(
      runId,
      targetNodeId,
      'passed',
      'node.transition.checked',
    );

    // --- Step 6: Re-execute review node to produce fresh review artifact ---
    await checkedTransitionNode(
      runId,
      reviewNode.id,
      'needs-revision',
      'node.transition.checked',
    );
    await checkedTransitionNode(
      runId,
      reviewNode.id,
      'running',
      'node.transition.checked',
    );

    const reviewReRunRoleRunId = `role_run_${randomUUID()}`;
    await repositories.createRoleRun({
      id: reviewReRunRoleRunId,
      runId,
      nodeId: reviewNode.id,
      role: reviewNode.role,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const reviewReRunLease = await leaseService.createExecutionLease(runId, {
      id: reviewNode.id,
      role: reviewNode.role,
      phaseId: reviewNode.phaseId,
    });

    try {
      const reviewResult = await adapter.runAgent(
        await helpers.agentInputForLease(
          runId,
          reviewNode,
          reviewReRunLease,
          await promptBuilder.buildNodePrompt(runId, reviewNode),
        ),
      );
      assertSuccessfulAgentRun(reviewResult);
      await repositories.markRoleRunCompleted({
        roleRunId: reviewReRunRoleRunId,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      await repositories.transitionNode(reviewNode.id, 'interrupted');
      await audit.append({
        runId,
        type: 'gate.rework.review.re-execute.failed',
        payload: {
          reviewNodeId: reviewNode.id,
          targetNodeId,
          reworkNodeId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return;
    }

    // --- Step 7: Put review node back to awaiting-gate ---
    await repositories.transitionNode(reviewNode.id, 'awaiting-gate');

    try {
      await leaseService.finalizeExecutionLease(runId, reviewNode.id);
    } catch {
      // Lease finalize failed for review re-run — non-fatal for rework flow.
    }

    await audit.append({
      runId,
      type: 'gate.rework.completed',
      payload: {
        reviewNodeId: reviewNode.id,
        targetNodeId,
        reworkNodeId,
        attempt,
      },
    });
  }

  return {
    attemptChangesRequestedRework,
    resolveReviewTargetNode,
  };
}
