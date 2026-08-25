import { randomUUID } from 'node:crypto';

import type { ArtifactType } from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentAdapter } from '../runtime/agent-adapter.js';
import {
  runAgentWithStepEvents,
  type AgentEventSink,
} from '../runtime/agent-step-events.js';
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
import { isWorkflowTerminalError } from './errors.js';
import { writeWorkflowTerminal } from './state-machine.js';
import { isJobCancellationAbort } from '../session/job-runner.js';

export interface NodeExecutorDeps {
  repositories: TekonRepositories;
  audit: AuditLogger;
  adapter: AgentAdapter;
  leaseService: LeaseService;
  helpers: WorkflowHelpers;
  promptBuilder: PromptBuilder;
  gateRunner: GateRunner;
  getCheckedTransition(): CheckedTransitionFn;
  /**
   * S5: job-level abort signal. When aborted, the agent run is short-
   * circuited and the workflow settles `cancelled` (M2 idempotent) instead
   * of `interrupted`. Absent = legacy behavior.
   */
  signal?: AbortSignal;
  /**
   * Phase 2 S3: optional best-effort sink for agent-loop step events
   * (step/start, tool/*, assistant/message, agent/error, step/end). The web
   * executor wires the dual-write bridge; CLI passes nothing → no events. MUST
   * be best-effort (never throw) — C1 governance zero-regression.
   */
  agentEventSink?: AgentEventSink;
}

export interface NodeExecutor {
  executeNode(runId: string, node: ExecutableNode): Promise<boolean>;
  appendPmoNodeCheckpoint(runId: string, node: ExecutableNode): Promise<void>;
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
      // SHOULD4: the previous worker crashed mid-node; mark its leftover
      // running role_run as interrupted so recovery has a symmetric API.
      const staleRoleRun = await repositories.getLatestRoleRunForNode(
        runId,
        node.id,
      );
      if (staleRoleRun?.status === 'running') {
        await repositories.markRoleRunInterrupted({
          roleRunId: staleRoleRun.id,
          interruptedAt: new Date().toISOString(),
        });
      }
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
        if (deps.signal?.aborted) {
          await repositories.markRoleRunInterrupted({
            roleRunId,
            interruptedAt: new Date().toISOString(),
          });
          await repositories.transitionNode(node.id, 'interrupted');
          const cancelled = isJobCancellationAbort(deps.signal);
          if (cancelled) {
            await writeWorkflowTerminal(
              repositories,
              runId,
              'cancelled',
              node.id,
            );
          } else {
            await repositories.updateWorkflowInstanceStatus(
              runId,
              'interrupted',
              node.id,
            );
          }
          await leaseService
            .finalizeExecutionLease(runId, node.id)
            .catch(() => {});
          await audit.append({
            runId,
            type: 'node.interrupted',
            payload: {
              nodeId: node.id,
              error: cancelled
                ? 'cancelled before agent start'
                : 'job ownership lost before agent start',
            },
          });
          return false;
        }
        let agentSucceeded = false;
        try {
          const agentInput = await helpers.agentInputForLease(
            runId,
            node,
            lease,
            await promptBuilder.buildNodePrompt(runId, node),
          );
          if (deps.signal) {
            // S5: propagate the job-level signal into the agent run so the
            // adapter can short-circuit / kill its subprocess.
            agentInput.signal = deps.signal;
          }
          const agentResult = await runAgentWithStepEvents(
            adapter,
            agentInput,
            {
              runId,
              nodeId: node.id,
              role: node.role,
              promptSummary: agentInput.prompt,
            },
            deps.agentEventSink,
          );
          assertSuccessfulAgentRun(agentResult);
          agentSucceeded = true;
          await repositories.markRoleRunCompleted({
            roleRunId,
            completedAt: new Date().toISOString(),
          });
        } finally {
          if (!agentSucceeded) {
            // P1-05: the agent did not complete — mark this role_run as
            // interrupted (symmetric to markRoleRunCompleted) so recovery
            // can distinguish crashed runs from finished ones.
            await repositories.markRoleRunInterrupted({
              roleRunId,
              interruptedAt: new Date().toISOString(),
            });
            await repositories.transitionNode(node.id, 'interrupted');
            if (isJobCancellationAbort(deps.signal)) {
              // S5: abort path — the workflow settles `cancelled` via the
              // idempotent terminal writer (M2), not `interrupted`.
              await writeWorkflowTerminal(
                repositories,
                runId,
                'cancelled',
                node.id,
              );
            } else {
              await repositories.updateWorkflowInstanceStatus(
                runId,
                'interrupted',
                node.id,
              );
            }
            await leaseService
              .finalizeExecutionLease(runId, node.id)
              .catch(() => {});
          }
        }
      } catch (error) {
        // A terminal-status conflict must propagate to the executor (which
        // maps it to job cancelled), never be swallowed into `interrupted`.
        if (isWorkflowTerminalError(error)) {
          throw error;
        }
        await repositories.transitionNode(node.id, 'interrupted');
        if (isJobCancellationAbort(deps.signal)) {
          // S5: the finally block above (or the pre-agent check) already
          // settled the run via writeWorkflowTerminal; this second call is
          // the idempotent no-op path (written=false). If the failure
          // happened before the inner try (e.g. lease creation), this is
          // the sole cancel write.
          await writeWorkflowTerminal(
            repositories,
            runId,
            'cancelled',
            node.id,
          );
        } else {
          await repositories.updateWorkflowInstanceStatus(
            runId,
            'interrupted',
            node.id,
          );
        }
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
        const passed = await gateRunner.runGateWithRepair(runId, node, gate);
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

    await checkedTransitionNode(runId, node.id, 'passed', 'node.passed');
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
