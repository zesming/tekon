import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createArtifactStore } from '../artifact/store.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import { createGateEngine, type GateEngine } from '../gate/engine.js';
import {
  buildRolePrompt,
  type RolePromptArtifactSummary,
} from '../role/prompt-builder.js';
import { loadRole } from '../role/loader.js';
import {
  loadRepoProfile,
  repoProfileCommandResolution,
} from '../repo/profile.js';
import type { AgentAdapter, AgentRunInput } from '../runtime/agent-adapter.js';
import type { AgentRunResult } from '../runtime/agent-adapter.js';
import { createCommandGateway } from '../runtime/command-gateway.js';
import type { WorktreeManager } from '../runtime/worktree-manager.js';
import type { CommandPolicy, WorktreeLease } from '../types/config.js';
import type {
  ArtifactType,
  GateConfig,
  GateResult,
  Node,
  Role,
  WorkflowInstance,
} from '../types/domain.js';
import { assertWorkflowTransition } from './state-machine.js';
import {
  loadWorkflowTemplate,
  type WorkflowArtifactInputRef,
  type WorkflowArtifactOutputRef,
  type WorkflowGateConfig,
  type WorkflowTemplate,
  type WorkflowTemplateNode,
  type WorkflowTemplatePhase,
} from './template.js';

export interface WorkflowEngineStartInput {
  demandText: string;
  mode: 'template' | 'dynamic';
  templateName?: string;
  workflowSpec?: WorkflowTemplate;
}

export interface WorkflowEngineResult {
  runId: string;
  workflow: WorkflowInstance;
}

export interface WorkflowEngine {
  startRun(input: WorkflowEngineStartInput): Promise<WorkflowEngineResult>;
  resumeRun(runId: string): Promise<WorkflowEngineResult>;
}

export interface CreateWorkflowEngineOptions {
  repoPath: string;
  dataDir: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  adapter: AgentAdapter;
  gateEngine?: GateEngine;
  worktreeManager?: WorktreeManager;
  baseRef?: string;
  allowDirtyBase?: boolean;
  agentProvider?: AgentRunResult['provider'];
  agentConfigSummary?: Record<string, unknown>;
  builtInRolesDir?: string;
  userHome?: string;
}

interface ExecutableNode {
  id: string;
  role: Role;
  phaseId?: string;
  inputs: WorkflowArtifactInputRef[];
  outputs: WorkflowArtifactOutputRef[];
  gates: WorkflowGateConfig[];
  dependsOn: string[];
}

interface ExecutionPlan {
  phases: Array<{
    id: string;
    name: string;
    nodes: ExecutableNode[];
  }>;
}

export function createWorkflowEngine(
  options: CreateWorkflowEngineOptions,
): WorkflowEngine {
  const gateEngine =
    options.gateEngine ??
    createGateEngine({
      repositories: options.repositories,
      gateway: createCommandGateway({ repositories: options.repositories }),
    });
  const artifactStore = createArtifactStore({
    repoPath: options.repoPath,
    repositories: options.repositories,
  });
  const executionLeases = new Map<string, WorktreeLease>();

  return {
    async startRun(input) {
      const template =
        input.workflowSpec ??
        loadWorkflowTemplate({
          name: input.templateName ?? 'standard-delivery',
        });
      const runId = `run_${randomUUID()}`;
      const projectId = `project_${randomUUID()}`;
      const demandId = `demand_${randomUUID()}`;
      const now = new Date().toISOString();

      mkdirSync(join(options.repoPath, options.dataDir, 'runs', runId), {
        recursive: true,
      });
      await options.repositories.createDemand({
        id: demandId,
        title: input.demandText.slice(0, 80),
        body: input.demandText,
        source: input.mode,
        createdAt: now,
      });
      await options.repositories.createProject({
        id: projectId,
        name: 'tekon',
        repoPath: options.repoPath,
        createdAt: now,
      });
      await options.repositories.createWorkflowInstance({
        id: runId,
        projectId,
        demandId,
        status: 'running',
        createdAt: now,
        updatedAt: now,
      });
      if (options.agentProvider) {
        await options.repositories.recordRunProviderConfig({
          runId,
          provider: options.agentProvider,
          configSummary: options.agentConfigSummary ?? {},
          createdAt: now,
        });
      }

      const plan = templateToPlan(template, runId);
      await persistPlan(runId, plan, options.repositories);
      await options.audit.append({
        runId,
        type: 'run.started',
        payload: { templateId: template.id, mode: input.mode },
      });

      const workflow = await executePlan(runId, plan);
      return { runId, workflow };
    },

    async resumeRun(runId) {
      const existing = await options.repositories.getWorkflowInstance(runId);
      if (!existing) {
        throw new Error(`run not found: ${runId}`);
      }

      const terminalStatuses: ReadonlyArray<string> = [
        'passed',
        'failed',
        'cancelled',
      ];
      if (terminalStatuses.includes(existing.status)) {
        return {
          error: `cannot resume run in terminal status: ${existing.status}`,
          runId,
          workflow: existing,
        } as unknown as WorkflowEngineResult;
      }

      await options.repositories.updateWorkflowInstanceStatus(runId, 'running');
      await options.audit.append({
        runId,
        type: 'run.resumed',
        payload: {},
      });

      const plan = await planFromRepository(runId, options.repositories);
      const workflow = await executePlan(runId, plan);
      return { runId, workflow };
    },
  };

  /**
   * Checked transition: reads current node status, validates legality,
   * performs the transition, and writes an audit event.
   * Throws if the transition is illegal from the current state.
   */
  async function checkedTransitionNode(
    runId: string,
    nodeId: string,
    to: Parameters<typeof assertWorkflowTransition>[1],
    auditType: string,
    auditPayload: Record<string, unknown> = {},
  ): Promise<void> {
    const current = await options.repositories.getNode(nodeId);
    if (!current) {
      throw new Error(`node not found: ${nodeId}`);
    }
    assertWorkflowTransition(current.status, to);
    await options.repositories.transitionNode(nodeId, to);
    await options.audit.append({
      runId,
      type: auditType,
      payload: { nodeId, from: current.status, to, ...auditPayload },
    });
  }

  async function executePlan(
    runId: string,
    plan: ExecutionPlan,
  ): Promise<WorkflowInstance> {
    for (const phase of plan.phases) {
      for (const node of phase.nodes) {
        const persisted = await options.repositories.getNode(node.id);
        if (persisted?.status === 'passed' || persisted?.status === 'skipped') {
          continue;
        }

        const dependencyMissing = await hasMissingArtifactDependency(
          runId,
          node,
        );
        if (dependencyMissing) {
          await options.repositories.transitionNode(node.id, 'blocked');
          await options.repositories.updateWorkflowInstanceStatus(
            runId,
            'blocked',
            node.id,
          );
          return mustGetWorkflow(runId);
        }

        const completed = await executeNode(runId, node);
        if (!completed) {
          return mustGetWorkflow(runId);
        }
      }
    }

    const passed = await options.repositories.updateWorkflowInstanceStatus(
      runId,
      'passed',
      null,
    );
    await options.audit.append({
      runId,
      type: 'run.passed',
      payload: {},
    });
    return passed ?? (await mustGetWorkflow(runId));
  }

  async function executeNode(
    runId: string,
    node: ExecutableNode,
  ): Promise<boolean> {
    const current = await options.repositories.getNode(node.id);
    if (!current) {
      throw new Error(`node not found: ${node.id}`);
    }

    const resumableLease = await activeExecutionLease(runId, node.id);
    const completedAgentRun = await hasCompletedAgentRun(runId, node.id);
    if (
      Boolean(resumableLease) &&
      current.status === 'running' &&
      !completedAgentRun
    ) {
      await options.repositories.transitionNode(node.id, 'interrupted');
      await options.repositories.updateWorkflowInstanceStatus(
        runId,
        'interrupted',
        node.id,
      );
      await options.audit.append({
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
        assertWorkflowTransition('paused', 'running');
        await options.repositories.transitionNode(node.id, 'running');
        await options.repositories.transitionNode(node.id, 'awaiting-gate');
      } else if (current.status === 'running') {
        assertWorkflowTransition('running', 'awaiting-gate');
        await options.repositories.transitionNode(node.id, 'awaiting-gate');
      }
      await options.repositories.updateWorkflowInstanceStatus(
        runId,
        'running',
        node.id,
      );
      await options.audit.append({
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
      await options.repositories.updateWorkflowInstanceStatus(
        runId,
        'running',
        node.id,
      );
      await options.audit.append({
        runId,
        type: 'node.started',
        payload: { nodeId: node.id, role: node.role },
      });

      try {
        const roleRunId = `role_run_${randomUUID()}`;
        await options.repositories.createRoleRun({
          id: roleRunId,
          runId,
          nodeId: node.id,
          role: node.role,
          status: 'running',
          startedAt: new Date().toISOString(),
        });
        const lease = await createExecutionLease(runId, node);
        let agentSucceeded = false;
        try {
          const agentResult = await options.adapter.runAgent(
            await agentInputForLease(
              runId,
              node,
              lease,
              await buildNodePrompt(runId, node),
            ),
          );
          assertSuccessfulAgentRun(agentResult);
          agentSucceeded = true;
          await options.repositories.markRoleRunCompleted({
            roleRunId,
            completedAt: new Date().toISOString(),
          });
        } finally {
          if (!agentSucceeded) {
            await options.repositories.transitionNode(node.id, 'interrupted');
            await options.repositories.updateWorkflowInstanceStatus(
              runId,
              'interrupted',
              node.id,
            );
            await finalizeExecutionLease(runId, node.id).catch(() => {});
          }
        }
      } catch (error) {
        await options.repositories.transitionNode(node.id, 'interrupted');
        await options.repositories.updateWorkflowInstanceStatus(
          runId,
          'interrupted',
          node.id,
        );
        await options.audit.append({
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
        const passed = await runGateWithRepair(runId, node, gate);
        if (!passed) {
          return false;
        }
      }
    } catch (error) {
      await options.repositories.transitionNode(node.id, 'interrupted');
      await options.repositories.updateWorkflowInstanceStatus(
        runId,
        'interrupted',
        node.id,
      );
      await options.audit.append({
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
      await recordQaValidationRef(runId, node);
      await finalizeExecutionLease(runId, node.id);
    } catch (error) {
      await options.repositories.transitionNode(node.id, 'interrupted');
      await options.repositories.updateWorkflowInstanceStatus(
        runId,
        'interrupted',
        node.id,
      );
      await options.audit.append({
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
      const artifacts = await options.repositories.listArtifacts(
        runId,
        node.id,
        artifactType,
      );
      if (artifacts.length === 0) {
        missingArtifacts.push(artifactType);
      }
    }
    const gateResults = await options.repositories.listGateResults(runId);
    await options.audit.append({
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
        latestGateStatuses: latestGateResultsForNode(gateResults, node.id),
      },
    });
  }

  async function runGateWithRepair(
    runId: string,
    node: ExecutableNode,
    gate: WorkflowGateConfig,
  ): Promise<boolean> {
    const existingResult = await latestGateResult(
      runId,
      node.id,
      gate.type,
      gate.gateKey,
      gate.type === 'human' && isFirstHumanGate(node.gates, gate.gateKey),
    );
    if (
      existingResult?.status === 'passed' ||
      existingResult?.status === 'skipped'
    ) {
      await options.audit.append({
        runId,
        type: 'gate.previously-passed',
        payload: {
          nodeId: node.id,
          gateType: gate.type,
          gateKey: gate.gateKey,
        },
      });
      return true;
    }

    if (gate.type === 'qa-signoff') {
      await recordQaValidationRef(runId, node);
    }
    let result = await runGate(runId, node.id, gate);
    if (result.status === 'passed' || result.status === 'skipped') {
      await options.audit.append({
        runId,
        type: 'gate.passed',
        payload: {
          nodeId: node.id,
          gateType: gate.type,
          gateKey: gate.gateKey,
        },
      });
      return true;
    }

    if (result.status === 'blocked' && gate.type === 'human') {
      // The gate engine's runGate already calls requestHumanGate() which
      // creates the human decision and transitions the node to 'paused'.
      // We only need to emit the audit event here for observability.
      await options.audit.append({
        runId,
        type: 'human.gate.pending',
        payload: { nodeId: node.id, gateResultId: result.id },
      });
      return false;
    }

    if (gate.autoFix && gate.maxRetries > 0) {
      let retryAttempt = 0;
      let repairPassed = false;

      while (retryAttempt < gate.maxRetries && !repairPassed) {
        retryAttempt++;
        await options.repositories.transitionNode(node.id, 'needs-revision');
        await finalizeExecutionLease(runId, node.id);
        const repairNode = await gateEngine.createAutoFixRepairNode({
          failedGateResult: result,
          fixerRole: node.role,
        });
        await options.audit.append({
          runId,
          type: 'gate.repair.created',
          payload: {
            nodeId: node.id,
            repairNodeId: repairNode.id,
            gateResultId: result.id,
            attempt: retryAttempt,
            maxAttempts: gate.maxRetries,
          },
        });
        await options.repositories.transitionNode(repairNode.id, 'running');
        let repairSucceeded = false;
        try {
          const repairLease = await createExecutionLease(runId, {
            id: repairNode.id,
            role: repairNode.role,
            phaseId: repairNode.phaseId,
          });
          try {
            const repairResult = await options.adapter.runAgent(
              await agentInputForLease(
                runId,
                {
                  id: repairNode.id,
                  role: repairNode.role,
                  phaseId: repairNode.phaseId,
                },
                repairLease,
                await buildRepairPrompt(runId, repairNode, result),
              ),
            );
            assertSuccessfulAgentRun(repairResult);
            repairSucceeded = true;
          } finally {
            if (!repairSucceeded) {
              await finalizeExecutionLease(runId, repairNode.id).catch(() => {});
            }
          }
        } catch (error) {
          await options.repositories.transitionNode(repairNode.id, 'interrupted');
          await options.audit.append({
            runId,
            type: 'gate.repair.failed',
            payload: {
              nodeId: node.id,
              repairNodeId: repairNode.id,
              gateResultId: result.id,
              attempt: retryAttempt,
              error: error instanceof Error ? error.message : String(error),
            },
          });
          if (retryAttempt >= gate.maxRetries) {
            break;
          }
          result = await runGate(runId, node.id, gate);
          if (result.status === 'passed' || result.status === 'skipped') {
            repairPassed = true;
          }
          continue;
        }
        await options.repositories.transitionNode(repairNode.id, 'passed');
        const repairLease = await activeExecutionLease(runId, repairNode.id);
        if (repairLease) {
          executionLeases.set(node.id, repairLease);
        }
        await options.repositories.transitionNode(node.id, 'running');
        await options.repositories.transitionNode(node.id, 'awaiting-gate');
        result = await runGate(runId, node.id, gate);
        if (result.status === 'passed' || result.status === 'skipped') {
          repairPassed = true;
        }
      }

      if (repairPassed) {
        await options.audit.append({
          runId,
          type: 'gate.passed-after-repair',
          payload: {
            nodeId: node.id,
            gateType: gate.type,
            gateKey: gate.gateKey,
            attempts: retryAttempt,
          },
        });
        return true;
      }
    }

    // When an independent-review gate finds changes-requested, rework the
    // target (reviewed) node instead of blocking the review node.
    // Retries up to maxReworkAttempts (default 5) before falling through to blocked.
    const shouldRework = isChangesRequested(
      result.failureClassification,
      gate.type,
    );

    if (shouldRework) {
      const targetNodeId = await resolveReviewTargetNode(runId, node.id);
      if (targetNodeId) {
        const maxReworkAttempts = resolveMaxReworkAttempts(gate.maxRetries);
        let reworkAttempt = 0;
        let reworkPassed = false;

        while (reworkAttempt < maxReworkAttempts && !reworkPassed) {
          reworkAttempt++;
          await options.audit.append({
            runId,
            type: 'gate.rework.attempt',
            payload: {
              nodeId: node.id,
              targetNodeId,
              attempt: reworkAttempt,
              maxAttempts: maxReworkAttempts,
            },
          });

          await attemptChangesRequestedRework(
            runId,
            node,
            gate,
            result,
            targetNodeId,
            reworkAttempt,
          );

          // Re-run the gate to check if the rework fixed the issues
          result = await runGate(runId, node.id, gate);
          if (result.status === 'passed' || result.status === 'skipped') {
            reworkPassed = true;
          }
        }

        if (reworkPassed) {
          await options.repositories.transitionNode(node.id, 'passed');
          await options.audit.append({
            runId,
            type: 'gate.passed-after-rework',
            payload: {
              nodeId: node.id,
              gateType: gate.type,
              gateKey: gate.gateKey,
              reworkedTargetNodeId: targetNodeId,
              attempts: reworkAttempt,
            },
          });
          return true;
        }
      }
    }

    const exhaustedNodeStatus =
      gate.onExhausted === 'pause'
        ? 'paused'
        : gate.onExhausted === 'fail'
          ? 'failed'
          : 'blocked';
    await checkedTransitionNode(
      runId,
      node.id,
      exhaustedNodeStatus,
      'gate.failed',
      {
        gateType: gate.type,
        gateKey: gate.gateKey,
        gateResultId: result.id,
        onExhausted: gate.onExhausted,
      },
    );
    await options.repositories.updateWorkflowInstanceStatus(
      runId,
      exhaustedNodeStatus,
      node.id,
    );
    return false;
  }

  /**
   * Find the target node that a review artifact is reviewing.
   * Reads the review artifact to extract reviewProcess.targetNodeId.
   * Falls back to heuristic (latest upstream passed node) if artifact is unreadable.
   */
  async function resolveReviewTargetNode(
    runId: string,
    reviewNodeId: string,
  ): Promise<string | null> {
    try {
      // Try to read targetNodeId from the review artifact payload
      const reviewArtifacts = await options.repositories.listArtifacts(
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
        const artifactRoot = join(
          options.repoPath,
          options.dataDir,
          'runs',
          runId,
          'artifacts',
          reviewNodeId,
        );
        const artifactPath = join(artifactRoot, reviewArtifact.path);
        if (existsSync(artifactPath)) {
          try {
            const raw = readFileSync(artifactPath, 'utf8');
            const payload = JSON.parse(raw);
            const targetNodeId =
              payload?.reviewProcess?.targetNodeId as string | undefined;
            if (targetNodeId) {
              // Verify the target node exists in this run
              const targetNode =
                await options.repositories.getNode(targetNodeId);
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

    // Heuristic fallback: pick the latest upstream passed node
    try {
      const nodes = await options.repositories.listNodes(runId);
      return resolveReviewTargetNodeByHeuristic(nodes, reviewNodeId);
    } catch {
      // Ignore
    }
    return null;
  }

  /**
   * Attempt to rework the target node when an independent review finds
   * changes-requested.
   *
   * Full rework flow:
   * 1. Transition target from passed to needs-revision
   * 2. Create a rework node that reuses the target's inputs/outputs/gates
   * 3. Run the target node's agent with review feedback (writing artifacts
   *    to the target node's output directory so they overwrite the originals)
   * 4. Run all target node gates on the rework node to validate output
   * 5. Finalize the rework lease (commit code-changes if any)
   * 6. Re-execute the review node's agent to produce a fresh review artifact
   * 7. Transition review node to awaiting-gate for caller to verify
   */
  async function attemptChangesRequestedRework(
    runId: string,
    reviewNode: ExecutableNode,
    gate: WorkflowGateConfig,
    gateResult: GateResult,
    targetNodeId: string,
    attempt: number,
  ): Promise<void> {
    const targetNode = await options.repositories.getNode(targetNodeId);
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

    // Build rework prompt with full role context + review feedback
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

    // Finalize any existing lease on the review node before creating new ones
    await finalizeExecutionLease(runId, reviewNode.id);

    // --- Step 2: Create rework node reusing target's inputs/outputs/gates ---
    const now = new Date().toISOString();
    await options.repositories.createNode({
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
    // Create a role run for tracking
    const reworkRoleRunId = `role_run_${randomUUID()}`;
    await options.repositories.createRoleRun({
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

    // Create a fresh lease for the rework
    const reworkLease = await createExecutionLease(runId, {
      id: reworkNodeId,
      role: targetNode.role,
      phaseId: targetNode.phaseId,
    });

    try {
      // Run the target's agent with review feedback.
      // Pass targetNodeId so artifacts are written to the target's output
      // directory and stored under the target's node ID (overwriting originals).
      let reworkSucceeded = false;
      try {
        const reworkResult = await options.adapter.runAgent(
          await agentInputForLease(
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
        await options.repositories.markRoleRunCompleted({
          roleRunId: reworkRoleRunId,
          completedAt: new Date().toISOString(),
        });
      } finally {
        if (!reworkSucceeded) {
          await finalizeExecutionLease(runId, reworkNodeId).catch(() => {});
        }
      }
    } catch (error) {
      await options.repositories.transitionNode(reworkNodeId, 'interrupted');
      await options.audit.append({
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

    // --- Step 4: Run target node's gates on rework node ---
    await options.repositories.transitionNode(reworkNodeId, 'awaiting-gate');
    const configuredTargetGates = gatesWithStableKeys(targetGates, reworkNodeId);
    for (const targetGate of configuredTargetGates) {
      const gatePassed = await runGateWithRepair(
        runId,
        {
          id: reworkNodeId,
          role: targetNode.role,
          phaseId: targetNode.phaseId,
          inputs: targetInputs,
          outputs: targetOutputs,
          gates: targetGates,
          dependsOn: [reviewNode.id],
        },
        targetGate,
      );
      if (!gatePassed) {
        // Rework output failed target gates — rework attempt failed.
        // Caller will retry or block.
        return;
      }
    }

    // --- Step 5: Finalize rework lease (commits code-changes if any) ---
    try {
      await finalizeExecutionLease(runId, reworkNodeId);
    } catch (error) {
      await options.repositories.transitionNode(reworkNodeId, 'interrupted');
      await options.audit.append({
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

    // Rework output validated — mark rework node and target as passed
    await checkedTransitionNode(
      runId,
      reworkNodeId,
      'passed',
      'node.transition.checked',
    );
    await checkedTransitionNode(
      runId,
      targetNodeId,
      'passed',
      'node.transition.checked',
    );

    // --- Step 6: Re-execute review node to produce fresh review artifact ---
    // The review node transitions awaiting-gate → needs-revision → running
    // (state machine requires needs-revision as intermediate step).
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
    await options.repositories.createRoleRun({
      id: reviewReRunRoleRunId,
      runId,
      nodeId: reviewNode.id,
      role: reviewNode.role,
      status: 'running',
      startedAt: new Date().toISOString(),
    });

    const reviewReRunLease = await createExecutionLease(runId, {
      id: reviewNode.id,
      role: reviewNode.role,
      phaseId: reviewNode.phaseId,
    });

    try {
      const reviewResult = await options.adapter.runAgent(
        await agentInputForLease(
          runId,
          reviewNode,
          reviewReRunLease,
          await buildNodePrompt(runId, reviewNode),
        ),
      );
      assertSuccessfulAgentRun(reviewResult);
      await options.repositories.markRoleRunCompleted({
        roleRunId: reviewReRunRoleRunId,
        completedAt: new Date().toISOString(),
      });
    } catch (error) {
      // Review agent failed — cannot produce fresh review.
      // Target rework itself was valid, so keep target as passed.
      await options.repositories.transitionNode(
        reviewNode.id,
        'interrupted',
      );
      await options.audit.append({
        runId,
        type: 'gate.rework.review.re-execute.failed',
        payload: {
          reviewNodeId: reviewNode.id,
          targetNodeId,
          reworkNodeId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      // Let the while-loop caller exhaust retries and mark review blocked.
      return;
    }

    // --- Step 7: Run review node gates, then transition to awaiting-gate ---
    await options.repositories.transitionNode(reviewNode.id, 'awaiting-gate');
    const reviewGates = gatesWithStableKeys(reviewNode.gates, reviewNode.id);
    for (const reviewGate of reviewGates) {
      const reviewGatePassed = await runGateWithRepair(
        runId,
        reviewNode,
        reviewGate,
      );
      if (!reviewGatePassed) {
        // Review gate failed — the fresh review still found issues or was
        // invalid. The caller's while-loop will check the gate result and
        // decide whether to retry or block.
        return;
      }
    }

    try {
      await finalizeExecutionLease(runId, reviewNode.id);
    } catch {
      // Lease finalize failed for review re-run — non-fatal for rework flow.
    }

    // Review re-execution complete. Node is in 'awaiting-gate'; caller will
    // re-run the independent-review gate to verify the new review artifact.

    await options.audit.append({
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

  /** Load the review artifact content for prompt injection. */
  async function loadReviewArtifactContent(
    runId: string,
    reviewNodeId: string,
  ): Promise<string> {
    try {
      const artifacts = await options.repositories.listArtifacts(
        runId,
        reviewNodeId,
      );
      const reviewArtifact = artifacts.find((a) =>
        ['technical-review', 'demand-review', 'requirement-interface-review'].includes(
          a.type,
        ),
      );
      if (reviewArtifact?.summary) {
        return reviewArtifact.summary;
      }
    } catch {
      // Fall through to default message
    }
    return 'Review found changes that need to be addressed.';
  }

  /**
   * Build a full role prompt for reworking a node after review feedback.
   * Includes prior node context, demand context, input artifact summaries,
   * and the review findings so the agent knows what to fix.
   */
  async function buildReworkNodePrompt(
    runId: string,
    targetNode: Node,
    targetInputs: WorkflowArtifactInputRef[],
    reviewFeedback: string,
  ): Promise<string> {
    const role = loadRole({
      role: targetNode.role,
      repoPath: options.repoPath,
      builtInRolesDir:
        options.builtInRolesDir ?? defaultBuiltInRolesDir(),
      userHome: options.userHome,
    });
    const workflow = await mustGetWorkflow(runId);
    const demand = await mustGetDemand(workflow.demandId);
    const reworkNodeForArtifacts: ExecutableNode = {
      id: targetNode.id,
      role: targetNode.role,
      phaseId: targetNode.phaseId,
      inputs: targetInputs,
      outputs: (targetNode.outputs ?? []) as WorkflowArtifactOutputRef[],
      gates: (targetNode.gates ?? []) as WorkflowGateConfig[],
      dependsOn: targetNode.dependencies ?? [],
    };
    const artifacts = await artifactSummariesForNode(
      runId,
      reworkNodeForArtifacts,
    );
    const allNodes = await options.repositories.listNodes(runId);
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
        repoPath: options.repoPath,
        dataDir: options.dataDir,
      },
      artifactSummaries: artifacts,
    });
  }

  async function runGate(
    runId: string,
    nodeId: string,
    gate: WorkflowGateConfig,
  ): Promise<GateResult> {
    const cwd = executionLeases.get(nodeId)?.worktreePath ?? options.repoPath;
    const resolvedGate = resolveGateCommand(gate);
    return gateEngine.runGate({
      runId,
      nodeId,
      gate: resolvedGate as GateConfig,
      cwd,
      artifactRoot: options.repoPath,
      outputDir: join(
        options.repoPath,
        options.dataDir,
        'runs',
        runId,
        'gates',
      ),
      policy: defaultCommandPolicy(cwd),
    });
  }

  function resolveGateCommand(gate: WorkflowGateConfig): WorkflowGateConfig {
    if (!gate.commandRef || gate.command) {
      return gate;
    }
    const profile = loadRepoProfile(options.repoPath);
    const resolution = repoProfileCommandResolution(profile, gate.commandRef);
    if (resolution.status === 'resolved') {
      return { ...gate, command: resolution.command };
    }
    if (resolution.status === 'not-applicable') {
      if (gate.type === 'security-scan') {
        return gate;
      }
      return {
        ...gate,
        skipReason: `repo profile commands.${gate.commandRef} is not applicable: ${resolution.reason}`,
      };
    }
    return gate;
  }

  async function createExecutionLease(
    runId: string,
    node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId'>,
  ): Promise<WorktreeLease> {
    if (!options.worktreeManager) {
      const lease = makeSyntheticLease(options.repoPath, runId, node);
      executionLeases.set(node.id, lease);
      return lease;
    }

    const runBranch = await options.worktreeManager.ensureRunBranch({
      repoPath: options.repoPath,
      runId,
      baseRef: options.baseRef ?? 'HEAD',
    });
    const lease = await options.worktreeManager.createLease({
      repoPath: options.repoPath,
      runId,
      nodeId: node.id,
      role: node.role,
      baseRef: runBranch,
      allowDirtyBase: options.allowDirtyBase,
    });
    await options.audit.append({
      runId,
      type: 'worktree.lease.created',
      payload: {
        nodeId: node.id,
        leaseId: lease.id,
        worktreePath: lease.worktreePath,
        branchName: lease.branchName,
      },
    });
    executionLeases.set(node.id, lease);
    return lease;
  }

  async function activeExecutionLease(
    runId: string,
    nodeId: string,
  ): Promise<WorktreeLease | undefined> {
    const inMemory = executionLeases.get(nodeId);
    if (inMemory && !inMemory.releasedAt) {
      return inMemory;
    }
    const leases = await options.repositories.listWorktreeLeases(runId);
    const activeLease = leases
      .filter((lease) => lease.nodeId === nodeId && !lease.releasedAt)
      .at(-1);
    if (activeLease) {
      executionLeases.set(nodeId, activeLease);
    }
    return activeLease;
  }

  async function finalizeExecutionLease(
    runId: string,
    nodeId: string,
  ): Promise<void> {
    const lease = await activeExecutionLease(runId, nodeId);
    if (!lease || !options.worktreeManager) {
      return;
    }
    const node = await options.repositories.getNode(nodeId);
    if (!nodeAllowsSourceChanges(node)) {
      const sourceInspection =
        await options.worktreeManager.inspectLeaseSourceChanges(lease.id);
      if (
        sourceInspection.changedPaths.length > 0 ||
        sourceInspection.headChanged
      ) {
        const changedPaths =
          sourceInspection.changedPaths.length > 0
            ? sourceInspection.changedPaths.join(', ')
            : `lease HEAD moved from ${sourceInspection.baseHead ?? 'unknown'} to ${sourceInspection.currentHead}`;
        throw new Error(
          `node ${nodeId} is not allowed to modify repository source files: ${changedPaths}`,
        );
      }
    }

    const committed = await options.worktreeManager.commitLeaseChanges(
      lease.id,
      {
        message: `Tekon ${runId} ${nodeId}`,
      },
    );
    const branchName = await options.worktreeManager.promoteLeaseToRunBranch({
      leaseId: lease.id,
    });
    await options.audit.append({
      runId,
      type: 'worktree.lease.promoted',
      payload: {
        nodeId,
        leaseId: lease.id,
        branchName,
        committed,
      },
    });
    await options.worktreeManager.releaseLease(lease.id);
    deleteLeaseAliases(lease.id);
    await options.audit.append({
      runId,
      type: 'worktree.lease.released',
      payload: {
        nodeId,
        leaseId: lease.id,
      },
    });
  }

  async function recordQaValidationRef(
    runId: string,
    node: ExecutableNode,
  ): Promise<void> {
    if (!options.worktreeManager || !isQaValidationNode(node)) {
      return;
    }
    const lease = await activeExecutionLease(runId, node.id);
    if (!lease) {
      return;
    }
    const head = await options.worktreeManager.getLeaseHead(lease.id);
    const ref = `sha:${head}`;
    if ((await latestQaValidationRef(runId)) === ref) {
      return;
    }
    await options.audit.append({
      runId,
      type: 'qa.validation.ref',
      payload: {
        nodeId: node.id,
        ref,
      },
    });
  }

  function isQaValidationNode(node: Pick<ExecutableNode, 'role' | 'outputs'>) {
    return (
      node.role === 'qa' &&
      node.outputs.some((output) =>
        ['test-report', 'ac-evidence'].includes(output.type),
      )
    );
  }

  function nodeAllowsSourceChanges(
    node: Pick<Node, 'outputs'> | null,
  ): boolean {
    return Boolean(
      node?.outputs.some((output) => output.type === 'code-changes'),
    );
  }

  function deleteLeaseAliases(leaseId: string): void {
    for (const [key, lease] of executionLeases.entries()) {
      if (lease.id === leaseId) {
        executionLeases.delete(key);
      }
    }
  }

  async function latestGateResult(
    runId: string,
    nodeId: string,
    gateType: GateConfig['type'],
    gateKey?: string,
    allowLegacyHumanFallback = false,
  ): Promise<GateResult | undefined> {
    const matchingResults = (
      await options.repositories.listGateResults(runId)
    ).filter(
      (result) => result.nodeId === nodeId && result.gateType === gateType,
    );
    const keyedResult = matchingResults
      .filter((result) =>
        gateKey ? result.gateKey === gateKey : !result.gateKey,
      )
      .at(-1);
    if (keyedResult) {
      return keyedResult;
    }
    if (gateType !== 'human' || !gateKey || !allowLegacyHumanFallback) {
      return undefined;
    }
    return matchingResults
      .filter(
        (result) =>
          !result.gateKey &&
          (result.status === 'passed' || result.status === 'skipped'),
      )
      .at(-1);
  }

  function isFirstHumanGate(
    gates: WorkflowGateConfig[],
    gateKey?: string,
  ): boolean {
    if (!gateKey) {
      return false;
    }
    return gates.find((gate) => gate.type === 'human')?.gateKey === gateKey;
  }

  function latestGateResultsForNode(
    gates: GateResult[],
    nodeId: string,
  ): Record<string, GateResult['status']> {
    const latest = new Map<string, GateResult>();
    for (const gate of gates.filter((item) => item.nodeId === nodeId)) {
      const key = gate.gateKey ?? gate.gateType;
      const existing = latest.get(key);
      if (
        !existing ||
        Date.parse(gate.createdAt) >= Date.parse(existing.createdAt)
      ) {
        latest.set(key, gate);
      }
    }
    return Object.fromEntries(
      [...latest.entries()].map(([gateKey, gate]) => [gateKey, gate.status]),
    );
  }

  function formatGateResultForPrompt(gate: GateResult): string {
    return `- gateResultId: ${gate.id} (context only: nodeId=${gate.nodeId}; gateType=${gate.gateType}; status=${gate.status})`;
  }

  async function agentInputForLease(
    runId: string,
    node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId'> & {
      inputs?: WorkflowArtifactInputRef[];
      outputs?: WorkflowArtifactOutputRef[];
      gates?: WorkflowGateConfig[];
      dependsOn?: string[];
    },
    lease: WorktreeLease,
    prompt: string,
    reworkTargetNodeId?: string,
  ): Promise<AgentRunInput> {
    const workflow = await mustGetWorkflow(runId);
    const effectiveNodeId = reworkTargetNodeId ?? node.id;
    const outputDir = join(
      options.repoPath,
      options.dataDir,
      'runs',
      runId,
      effectiveNodeId,
    );
    const requiredArtifactTypes = requiredArtifactTypesForNode(node);
    const allNodes = await options.repositories.listNodes(runId);
    const currentIndex = allNodes.findIndex((item) => item.id === node.id);
    const priorNodes = currentIndex >= 0 ? allNodes.slice(0, currentIndex) : [];
    const priorNodeContext = priorNodes.map((item) => ({
      id: item.id,
      role: item.role,
      status: item.status,
      outputs: item.outputs,
      gates: item.gates,
    }));
    const deliveryRef = await deliveryRefForNode(runId, node, lease);
    const promptWithDeliveryRef =
      deliveryRef &&
      node.outputs?.some((output) => output.type === 'qa-release-signoff')
        ? [
            prompt,
            '',
            `For qa-release-signoff.targetRef and validatedRef, use this exact tested delivery ref: ${deliveryRef}.`,
          ].join('\n')
        : prompt;

    return {
      roleConfig: { role: node.role },
      prompt: appendArtifactProtocol(promptWithDeliveryRef, {
        nodeId: node.id,
        outputDir,
        role: node.role,
        nodeInputs: node.inputs ?? [],
        priorNodes: priorNodeContext,
        requiredArtifactTypes,
      }),
      worktreeLease: lease,
      outputDir,
      commandPolicy: defaultCommandPolicy(lease.worktreePath),
      runContext: {
        runId,
        nodeId: effectiveNodeId,
        projectId: workflow.projectId,
        repoPath: lease.worktreePath,
        dataDir: options.dataDir,
      },
      nodeInputs: node.inputs ?? [],
      nodeDependencies: node.dependsOn ?? [],
      deliveryRef,
      priorNodes: priorNodeContext,
      artifactStore,
      requiredArtifactTypes,
    };
  }

  async function deliveryRefForNode(
    runId: string,
    node: { outputs?: WorkflowArtifactOutputRef[] },
    lease: WorktreeLease,
  ): Promise<string | undefined> {
    const latest = await latestQaValidationRef(runId);
    if (latest) {
      return latest;
    }
    if (
      options.worktreeManager &&
      node.outputs?.some((output) => output.type === 'qa-release-signoff')
    ) {
      return `sha:${await options.worktreeManager.getLeaseHead(lease.id)}`;
    }
    return undefined;
  }

  async function hasMissingArtifactDependency(
    runId: string,
    node: ExecutableNode,
  ): Promise<boolean> {
    for (const input of node.inputs) {
      const artifacts = await options.repositories.listArtifacts(
        runId,
        input.fromNodeId,
        input.type,
      );
      if (artifacts.length === 0) {
        await options.audit.append({
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

  function requiredArtifactTypesForNode(input: {
    outputs?: WorkflowArtifactOutputRef[];
    gates?: WorkflowGateConfig[];
  }): ArtifactType[] {
    const required = new Set<ArtifactType>();
    for (const output of input.outputs ?? []) {
      required.add(output.type);
    }
    for (const gate of input.gates ?? []) {
      if (gate.type === 'schema' && gate.artifactType) {
        required.add(gate.artifactType);
      }
    }
    return [...required];
  }

  function appendArtifactProtocol(
    prompt: string,
    input: {
      nodeId: string;
      outputDir: string;
      role: Role;
      nodeInputs: WorkflowArtifactInputRef[];
      priorNodes: Array<Pick<Node, 'id' | 'role'>>;
      requiredArtifactTypes: ArtifactType[];
    },
  ): string {
    if (input.requiredArtifactTypes.length === 0) {
      return prompt;
    }
    const isCodeChangesRdNode =
      input.role === 'rd' &&
      input.requiredArtifactTypes.includes('code-changes');

    const manifestExample = JSON.stringify(
      {
        artifacts: input.requiredArtifactTypes.map((type) => ({
          type,
          path: `${type}.json`,
          summary: `${type} summary`,
        })),
      },
      null,
      2,
    );
    return [
      prompt,
      '',
      'Tekon artifact protocol:',
      "- Complete only this workflow node's responsibilities.",
      '- This provider node produces internal Tekon artifacts; outer Tekon QA, reviewer, and PMO nodes handle workflow review and delivery evidence.',
      '- Do not spawn subagents, delegate review, or wait for external agents inside this node.',
      ...(isCodeChangesRdNode
        ? [
            '- For RD code-changes nodes, this artifact protocol overrides role skills or local instructions that would otherwise require tests, nested or delegated reviews, dependency installation, or extra diagnostics before manifest creation.',
          ]
        : []),
      !input.requiredArtifactTypes.includes('code-changes')
        ? '- Required artifact types do not include code-changes; do not modify the repository working tree; write only node artifacts under TEKON_OUTPUT_DIR.'
        : '- Keep repository edits scoped to the requested code-changes artifact and this workflow node.',
      '- Do not run git add, git commit, git push, or create PRs inside this node.',
      '- Leave repository edits in the worktree; Tekon Engine promotes and commits passed node changes after gates.',
      `- Write all node artifacts under TEKON_OUTPUT_DIR (${input.outputDir}).`,
      `- Required artifact types: ${input.requiredArtifactTypes.join(', ')}.`,
      '- Each artifact may be JSON, YAML front matter, or Markdown accepted by the Tekon artifact schema.',
      '- Structured JSON artifacts must include non-empty title and body fields.',
      ...(input.requiredArtifactTypes.some(
        (type) => type === 'demand-card' || type === 'prd',
      )
        ? [
            '- For demand-card and prd JSON artifacts, include acceptanceCriteria with id and description fields.',
          ]
        : []),
      ...(input.requiredArtifactTypes.some((type) =>
        ['test-report', 'ac-evidence', 'qa-release-signoff'].includes(type),
      )
        ? [
            '- For test-report, ac-evidence, and qa-release-signoff JSON artifacts, criteriaEvidence[] must use exact fields criterionId, status, and evidence.',
            '- Create one criteriaEvidence item per acceptance criterion id. criterionId must be exactly one criterion id from the demand/PRD, such as AC-PRD-1; never combine ids with "/", commas, arrays, or grouped labels. Duplicate shared evidence across separate items when needed.',
            '- criteriaEvidence[].evidence must be a non-empty string; use per-item outputPaths, gateResultIds, or artifactIds for evidence anchors when anchors are required.',
            '- Do not put evidence anchors only at artifact top-level; gate checks read anchors from each criteriaEvidence item.',
            '- criteriaEvidence[].artifactIds must use exact artifactId values shown in the Artifacts section; nodeId:type labels are not valid artifactIds.',
            '- criteriaEvidence[].gateResultIds must use exact gateResultId values from Prior eligible gate results; do not use gateKey, nodeId:gateKey labels, commandRef labels, outputPath, or log file names.',
            '- If you do not have an exact artifactId, omit artifactIds and use outputPaths or known gateResultIds instead.',
            '- criteriaEvidence[].status must be one of passed, failed, blocked, or unknown; do not use id, evidenceSummary, coverage, or extended status labels as substitutes.',
          ]
        : []),
      ...(input.requiredArtifactTypes.includes('test-report')
        ? [
            '- For test-report JSON artifacts, summary is optional but must be a string when present; do not write summary as an object.',
          ]
        : []),
      ...(input.requiredArtifactTypes.includes('qa-release-signoff')
        ? [
            '- For qa-release-signoff JSON artifacts, include targetRef, validatedRef, and overallStatus.',
            '- qa-release-signoff.overallStatus must be one of passed, failed, or blocked; do not use decision or recommendation as a substitute.',
          ]
        : []),
      ...(input.requiredArtifactTypes.some((type) =>
        ['ac-evidence', 'qa-release-signoff'].includes(type),
      )
        ? [
            '- For ac-evidence and qa-release-signoff JSON artifacts, each criteriaEvidence item must include at least one evidence anchor: outputPaths pointing to a file under TEKON_OUTPUT_DIR or an existing repo path, or known gateResultIds/artifactIds.',
            '- If a criterion depends on downstream delivery packaging, PR creation, PMO checkpoint, QA signoff, or QA signoff review, do not block this QA validation node solely because those downstream nodes have not run yet.',
          ]
        : []),
      ...(input.requiredArtifactTypes.includes('test-plan')
        ? [
            '- For test-plan JSON artifacts, include testBasis and testCases using the exact schema fields.',
            '- testBasis must be a non-empty string array.',
            '- testCases[].id and testCases[].description are required.',
            '- Do not use testScenarios, gatePlan, or acceptanceCoverage as substitutes for testCases.',
          ]
        : []),
      ...roleScopedReviewArtifactInstructions({
        nodeId: input.nodeId,
        role: input.role,
        nodeInputs: input.nodeInputs,
        priorNodes: input.priorNodes,
        requiredArtifactTypes: input.requiredArtifactTypes,
      }),
      `- Write the artifact manifest file to ${join(input.outputDir, 'artifact-manifest.json')}, containing an "artifacts" array with type, path, and summary for each artifact.`,
      '- Write required artifact files and the manifest file before optional checks or reviews.',
      ...(isCodeChangesRdNode
        ? [
            '- Do not run dependency installation, test, lint, typecheck, build, or package-manager commands before writing required code-changes artifacts and the manifest; Tekon gates run validation after artifact ingestion.',
          ]
        : []),
      '- After the manifest file is written, stop work and exit immediately.',
      '- Do not continue editing, formatting, running checks, printing diffs, or explaining unless this workflow node explicitly requires it before manifest creation.',
      '- Manifest format example:',
      manifestExample,
      '- Do not include secrets, tokens, credentials, or production-only data in artifacts or logs.',
    ].join('\n');
  }

  async function hasCompletedAgentRun(
    runId: string,
    nodeId: string,
  ): Promise<boolean> {
    const roleRun = await options.repositories.getLatestRoleRunForNode(
      runId,
      nodeId,
    );
    return roleRun?.status === 'passed' && Boolean(roleRun.completedAt);
  }

  async function mustGetWorkflow(runId: string): Promise<WorkflowInstance> {
    const workflow = await options.repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }
    return workflow;
  }

  async function buildNodePrompt(
    runId: string,
    node: ExecutableNode,
  ): Promise<string> {
    const role = loadRole({
      role: node.role,
      repoPath: options.repoPath,
      builtInRolesDir: options.builtInRolesDir ?? defaultBuiltInRolesDir(),
      userHome: options.userHome,
    });
    const workflow = await mustGetWorkflow(runId);
    const demand = await mustGetDemand(workflow.demandId);
    const artifacts = await artifactSummariesForNode(runId, node);
    const allNodes = await options.repositories.listNodes(runId);
    const currentIndex = allNodes.findIndex((item) => item.id === node.id);
    const priorNodes = currentIndex >= 0 ? allNodes.slice(0, currentIndex) : [];
    const gateResults = await options.repositories.listGateResults(runId);
    const visibleGateNodeIds = new Set([
      ...priorNodes.map((item) => item.id),
      node.id,
    ]);
    const eligibleGateResultLines = gateResults
      .filter(
        (gate) =>
          visibleGateNodeIds.has(gate.nodeId) &&
          (gate.status === 'passed' || gate.status === 'skipped'),
      )
      .map(formatGateResultForPrompt);
    const priorNodeLines = priorNodes.map((item) =>
      [
        `- ${item.id} role=${item.role} status=${item.status}`,
        item.outputs.length > 0
          ? `outputs=${item.outputs.map((output) => output.type).join(',')}`
          : 'outputs=none',
        item.gates.length > 0
          ? `gates=${gatesWithStableKeys(item.gates, item.id)
              .map((gate) => `${gate.type}:${gate.gateKey}`)
              .join(',')}`
          : 'gates=none',
      ].join(' '),
    );
    const processCheckpointRequired = node.outputs.some(
      (output) => output.type === 'process-checkpoint',
    );
    const pendingHumanDecisionCount = processCheckpointRequired
      ? (await options.repositories.listHumanDecisions(runId)).filter(
          (decision) => decision.status === 'pending',
        ).length
      : undefined;
    const expectedDeliveryRef = node.outputs.some(
      (output) => output.type === 'qa-release-signoff',
    )
      ? await latestQaValidationRef(runId)
      : undefined;
    return buildRolePrompt({
      role,
      taskInstruction: [
        `Demand title: ${demand.title}`,
        'Demand body:',
        demand.body,
        '',
        `Execute workflow node ${node.id}.`,
        node.inputs.length > 0
          ? `Declared input artifact aliases: ${node.inputs
              .map((input) => `${input.id}:${input.type}`)
              .join(', ')}.`
          : 'Declared input artifact aliases: none.',
        priorNodeLines.length > 0
          ? ['Prior workflow nodes:', ...priorNodeLines].join('\n')
          : 'Prior workflow nodes: none.',
        eligibleGateResultLines.length > 0
          ? ['Prior eligible gate results:', ...eligibleGateResultLines].join(
              '\n',
            )
          : 'Prior eligible gate results: none.',
        processCheckpointRequired
          ? [
              'For process-checkpoint.requiredNodes, include every prior workflow node listed above with the exact nodeId and status; do not invent, omit, rename, or reorder required nodes.',
              'process-checkpoint.artifactEvidence[] must use exact fields nodeId and type; do not use output, artifactId, path, exists, nonEmpty, sizeBytes, or sha256 as substitutes for type.',
              'process-checkpoint.gateEvidence[] must use exact fields nodeId, gateType, gateKey, and status; status must be passed or skipped, and observedStatus is not a valid substitute.',
              'process-checkpoint.humanDecisionEvidence.pending must be a non-negative integer count, not an array or list of pending actions.',
              `process-checkpoint.humanDecisionEvidence.pending must equal the current unresolved Tekon human decision count: ${pendingHumanDecisionCount}. Do not count manual review items, residual risks, PR/merge/release/deploy approvals, or future owner decisions unless they are currently pending Tekon human decisions.`,
            ].join('\n')
          : '',
        expectedDeliveryRef
          ? `For qa-release-signoff.targetRef and validatedRef, use this exact tested delivery ref: ${expectedDeliveryRef}.`
          : '',
        `Produce the requested artifacts and preserve evidence for gates.`,
      ]
        .filter((line) => line.length > 0)
        .join('\n'),
      projectContext: {
        runId,
        nodeId: node.id,
        projectId: workflow.projectId,
        repoPath: options.repoPath,
        dataDir: options.dataDir,
      },
      artifactSummaries: artifacts,
    });
  }

  async function buildRepairPrompt(
    runId: string,
    node: Pick<Node, 'id' | 'role' | 'phaseId'>,
    failedGate: GateResult,
  ): Promise<string> {
    const role = loadRole({
      role: node.role,
      repoPath: options.repoPath,
      builtInRolesDir: options.builtInRolesDir ?? defaultBuiltInRolesDir(),
      userHome: options.userHome,
    });
    const workflow = await mustGetWorkflow(runId);
    const demand = await mustGetDemand(workflow.demandId);
    return buildRolePrompt({
      role,
      taskInstruction: [
        `Demand title: ${demand.title}`,
        'Demand body:',
        demand.body,
        '',
        `Repair failed gate ${failedGate.id}.`,
        `Failed gate type: ${failedGate.gateType}.`,
        failedGate.failureClassification
          ? `Failure classification: ${failedGate.failureClassification}.`
          : 'Failure classification: unavailable.',
      ].join('\n'),
      projectContext: {
        runId,
        nodeId: node.id,
        projectId: workflow.projectId,
        repoPath: options.repoPath,
        dataDir: options.dataDir,
      },
    });
  }

  async function artifactSummariesForNode(
    runId: string,
    node: ExecutableNode,
  ): Promise<RolePromptArtifactSummary[]> {
    const summaries: RolePromptArtifactSummary[] = [];
    for (const input of node.inputs) {
      const artifacts = await options.repositories.listArtifacts(
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

  async function mustGetDemand(demandId: string) {
    const demand = await options.repositories.getDemand(demandId);
    if (!demand) {
      throw new Error(`demand not found: ${demandId}`);
    }
    return demand;
  }

  async function latestQaValidationRef(
    runId: string,
  ): Promise<string | undefined> {
    const events = await options.repositories.listAuditEvents(runId);
    return events
      .filter((event) => event.type === 'qa.validation.ref')
      .map((event) =>
        typeof event.payload.ref === 'string' ? event.payload.ref : undefined,
      )
      .filter((ref): ref is string => Boolean(ref))
      .at(-1);
  }
}

export function assertSuccessfulAgentRun(result: AgentRunResult): void {
  if (result.timedOut) {
    throw new Error(`agent timed out: provider=${result.provider}`);
  }

  if (result.exitCode !== 0) {
    throw new Error(
      `agent failed: provider=${result.provider} exitCode=${String(
        result.exitCode,
      )}`,
    );
  }
}

const roleScopedReviewArtifactTypes: ArtifactType[] = [
  'code-review',
  'demand-review',
  'qa-release-signoff-review',
  'requirement-interface-review',
  'technical-review',
  'test-plan-review',
];

function roleScopedReviewArtifactInstructions(input: {
  nodeId: string;
  role: Role;
  nodeInputs: WorkflowArtifactInputRef[];
  priorNodes: Array<Pick<Node, 'id' | 'role'>>;
  requiredArtifactTypes: ArtifactType[];
}): string[] {
  const reviewTypes = input.requiredArtifactTypes.filter((type) =>
    roleScopedReviewArtifactTypes.includes(type),
  );
  if (reviewTypes.length === 0) {
    return [];
  }

  return [
    '- For role-scoped review JSON artifacts, include reviewScope, reviewProcess, decision, and findings using the exact schema fields.',
    `- reviewProcess.mode must be "independent-agent" or "independent-process"; reviewProcess.reviewerRole must be "${input.role}".`,
    '- decision must be one of: approved, changes-requested, blocked.',
    '- findings must be an array; findings[].severity must be one of: critical, important, minor.',
    '- findings[].ownerRole is optional; if present, it must be one of: pm, rd, qa, reviewer, pmo.',
    '- findings[].message is required; put ids, category, impact, or recommendation details inside body or message, not in place of message.',
    '- Do not use reviewRole, reviewedArtifacts, or reviewScope as an array/object as substitutes for these schema fields.',
    ...reviewTypes.flatMap((type) =>
      roleScopedReviewArtifactExampleLines(type, input),
    ),
  ];
}

function roleScopedReviewArtifactExampleLines(
  type: ArtifactType,
  input: {
    nodeId: string;
    role: Role;
    nodeInputs: WorkflowArtifactInputRef[];
    priorNodes: Array<Pick<Node, 'id' | 'role'>>;
  },
): string[] {
  const target = reviewTargetForArtifact(type, input);
  const reviewScopes = reviewScopesForArtifact(type, input.role);
  const example = JSON.stringify(
    {
      title: `${type} review`,
      body: 'Review findings and rationale within this role scope.',
      reviewScope: reviewScopes[0],
      reviewProcess: {
        mode: 'independent-process',
        reviewerId: `${input.role}-${type}-reviewer`,
        reviewerRole: input.role,
        targetNodeId: target.nodeId,
        targetRole: target.role,
      },
      decision: 'approved',
      findings: [
        {
          severity: 'minor',
          ownerRole: input.role,
          message: 'No blocking issue found within this role scope.',
        },
      ],
    },
    null,
    2,
  );

  return [
    `- For ${type}, reviewScope must be ${reviewScopes
      .map((scope) => `"${scope}"`)
      .join(' or ')}; use targetNodeId "${target.nodeId}" and targetRole "${
      target.role
    }" unless the node explicitly reviews a more specific declared input.`,
    `- ${type} JSON example:`,
    example,
  ];
}

function reviewScopesForArtifact(type: ArtifactType, role: Role): string[] {
  if (type === 'demand-review') {
    return ['demand-quality'];
  }
  if (type === 'requirement-interface-review') {
    return ['requirement-interface'];
  }
  if (type === 'technical-review') {
    return ['technical-design', 'implementation-risk'];
  }
  if (type === 'test-plan-review') {
    return role === 'pm' ? ['test-plan-intent'] : ['test-plan'];
  }
  if (type === 'qa-release-signoff-review') {
    return ['release-signoff'];
  }
  if (type === 'code-review') {
    return ['code-change'];
  }
  return ['delivery-readiness'];
}

function reviewTargetForArtifact(
  type: ArtifactType,
  input: {
    nodeId: string;
    nodeInputs: WorkflowArtifactInputRef[];
    priorNodes: Array<Pick<Node, 'id' | 'role'>>;
  },
): { nodeId: string; role: Role } {
  const preferredArtifactTypes = preferredReviewTargetTypes(type);
  const targetInput =
    preferredArtifactTypes
      .map((artifactType) =>
        input.nodeInputs.find((candidate) => candidate.type === artifactType),
      )
      .find(Boolean) ?? input.nodeInputs[0];
  const targetNodeId = targetInput?.fromNodeId ?? input.nodeId;
  const targetRole =
    input.priorNodes.find((node) => node.id === targetNodeId)?.role ??
    fallbackTargetRoleForReviewArtifact(type);

  return { nodeId: targetNodeId, role: targetRole };
}

function preferredReviewTargetTypes(type: ArtifactType): ArtifactType[] {
  if (type === 'code-review') {
    return ['code-changes'];
  }
  if (type === 'demand-review') {
    return ['demand-card', 'prd'];
  }
  if (type === 'qa-release-signoff-review') {
    return ['qa-release-signoff'];
  }
  if (type === 'requirement-interface-review') {
    return ['demand-card', 'prd', 'demand-review'];
  }
  if (type === 'technical-review') {
    return ['implementation-plan'];
  }
  if (type === 'test-plan-review') {
    return ['test-plan'];
  }
  return [];
}

function fallbackTargetRoleForReviewArtifact(type: ArtifactType): Role {
  if (type === 'code-review') {
    return 'rd';
  }
  if (type === 'demand-review') {
    return 'pm';
  }
  if (type === 'qa-release-signoff-review') {
    return 'qa';
  }
  if (type === 'requirement-interface-review') {
    return 'pm';
  }
  if (type === 'technical-review') {
    return 'rd';
  }
  if (type === 'test-plan-review') {
    return 'qa';
  }
  return 'pmo';
}

async function persistPlan(
  runId: string,
  plan: ExecutionPlan,
  repositories: TekonRepositories,
) {
  const now = new Date().toISOString();
  for (const [phaseIndex, phase] of plan.phases.entries()) {
    await repositories.createPhase({
      id: phase.id,
      runId,
      name: phase.name,
      status: 'pending',
      order: phaseIndex,
      createdAt: now,
      updatedAt: now,
    });
    for (const node of phase.nodes) {
      await repositories.createNode({
        id: node.id,
        runId,
        phaseId: phase.id,
        role: node.role,
        status: 'pending',
        inputs: node.inputs,
        outputs: node.outputs,
        gates: node.gates.map((gate) => gate as GateConfig),
        dependencies: node.dependsOn,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
}

function templateToPlan(
  template: WorkflowTemplate,
  runId: string,
): ExecutionPlan {
  const nodeIdByTemplateId = new Map<string, string>();
  for (const phase of template.phases) {
    for (const node of phase.nodes) {
      nodeIdByTemplateId.set(node.id, scopedId(runId, node.id));
    }
  }

  return {
    phases: template.phases.map((phase) => ({
      id: scopedId(runId, phase.id),
      name: phase.name,
      nodes: phase.nodes.map((node) =>
        templateNodeToExecutable(runId, phase, node, nodeIdByTemplateId),
      ),
    })),
  };
}

function templateNodeToExecutable(
  runId: string,
  phase: WorkflowTemplatePhase,
  node: WorkflowTemplateNode,
  nodeIdByTemplateId: Map<string, string>,
): ExecutableNode {
  return {
    id: scopedId(runId, node.id),
    role: node.role,
    phaseId: scopedId(runId, phase.id),
    inputs: node.inputs.map((input) => ({
      ...input,
      fromNodeId: nodeIdByTemplateId.get(input.fromNodeId) ?? input.fromNodeId,
    })),
    outputs: node.outputs,
    gates: gatesWithStableKeys(node.gates, node.id),
    dependsOn: node.dependsOn.map(
      (dependency) => nodeIdByTemplateId.get(dependency) ?? dependency,
    ),
  };
}

async function planFromRepository(
  runId: string,
  repositories: TekonRepositories,
): Promise<ExecutionPlan> {
  const phases = await repositories.listPhases(runId);
  const nodes = await repositories.listNodes(runId);
  return {
    phases: phases.map((phase) => ({
      id: phase.id,
      name: phase.name,
      nodes: nodes
        .filter((node) => node.phaseId === phase.id)
        .map((node) => persistedNodeToExecutable(node)),
    })),
  };
}

export function scopedId(runId: string, id: string) {
  return `${runId}_${id}`;
}

function persistedNodeToExecutable(node: Node): ExecutableNode {
  return {
    id: node.id,
    role: node.role,
    phaseId: node.phaseId,
    inputs: node.inputs,
    outputs: node.outputs,
    gates: gatesWithStableKeys(node.gates as WorkflowGateConfig[], node.id),
    dependsOn: node.dependencies,
  };
}

export function gatesWithStableKeys<T extends GateConfig | WorkflowGateConfig>(
  gates: T[],
  nodeId = 'workflow node',
): Array<T & { gateKey: string }> {
  const keyed = gates.map((gate, index) => ({
    ...gate,
    gateKey: gate.gateKey ?? stableGateKey(gate, index),
  }));
  const seen = new Set<string>();
  for (const gate of keyed) {
    if (seen.has(gate.gateKey)) {
      throw new Error(
        `duplicate gateKey "${gate.gateKey}" in node "${nodeId}"`,
      );
    }
    seen.add(gate.gateKey);
  }
  return keyed;
}

export function stableGateKey(
  gate: Pick<
    GateConfig | WorkflowGateConfig,
    'type' | 'artifactType' | 'commandRef' | 'skipReason'
  >,
  index: number,
): string {
  return [
    String(index).padStart(2, '0'),
    gate.type,
    gate.artifactType ? `artifact=${gate.artifactType}` : '',
    gate.commandRef ? `commandRef=${gate.commandRef}` : '',
    gate.skipReason ? 'skipped' : '',
  ]
    .filter(Boolean)
    .join(':');
}

export function makeSyntheticLease(
  repoPath: string,
  runId: string,
  node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId'>,
): WorktreeLease {
  const now = new Date().toISOString();
  return {
    id: `lease_${node.id}`,
    runId,
    nodeId: node.id,
    role: node.role,
    repoPath,
    worktreePath: repoPath,
    branchName: `tekon/${runId}/${node.id}`,
    createdAt: now,
  };
}

export function defaultCommandPolicy(repoPath: string): CommandPolicy {
  return {
    allow: [
      { tool: 'git', args: [] },
      { tool: 'pnpm', args: [] },
      { tool: 'npm', args: [] },
      { tool: 'claude', args: [] },
      { tool: 'codex', args: [] },
    ],
    deny: [],
    requiresHumanApproval: [],
    cwdScope: [repoPath],
    network: 'disabled',
  };
}

export function defaultBuiltInRolesDir(): string {
  const fromModule = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
    'roles',
  );
  if (existsSync(fromModule)) {
    return fromModule;
  }
  return resolve(process.cwd(), 'roles');
}

/**
 * Heuristic for finding the review target when no explicit targetNodeId is
 * available: pick the last (most recent) upstream node whose status is
 * 'passed'. Returns null when no such node exists or when the review node
 * itself is not found in the list.
 */
export function resolveReviewTargetNodeByHeuristic(
  nodes: ReadonlyArray<{ id: string; status: string }>,
  reviewNodeId: string,
): string | null {
  const reviewNode = nodes.find((n) => n.id === reviewNodeId);
  if (!reviewNode) return null;

  const upstreamNodes = nodes.filter(
    (n) => n.id !== reviewNodeId && n.status === 'passed',
  );
  if (upstreamNodes.length > 0) {
    return upstreamNodes[upstreamNodes.length - 1].id;
  }
  return null;
}

/**
 * Returns true when a gate failure should trigger the changes-requested
 * rework flow: only independent-review gates with a changes-requested
 * classification qualify.
 */
export function isChangesRequested(
  failureClassification: string | null | undefined,
  gateType: string,
): boolean {
  return (
    failureClassification === 'changes-requested' &&
    gateType === 'independent-review'
  );
}

/**
 * Resolves the maximum number of rework attempts for a changes-requested
 * cycle. Falls back to 5 when gate.maxRetries is zero or negative.
 */
export function resolveMaxReworkAttempts(maxRetries: number): number {
  return maxRetries > 0 ? maxRetries : 5;
}
