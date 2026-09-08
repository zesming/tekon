import { randomUUID } from 'node:crypto';

import type { ArtifactType, AuditEvent } from '../types/domain.js';
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
import {
  assertSuccessfulAgentRun,
  requiredArtifactTypesForNode,
} from './helpers.js';
import type { PromptBuilder } from './prompt-builder.js';
import type { GateRunner } from './gate-runner.js';
import { isWorkflowTerminalError } from './errors.js';
import { writeWorkflowTerminal } from './state-machine.js';
import { isJobCancellationAbort, isJobOwnershipLostAbort, isJobShutdownAbort } from '../session/job-runner.js';

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
   * Job-level abort signal: user cancellation settles cancelled, shutdown
   * preserves an interrupted checkpoint, and ownership loss fences writes.
   * Absent means legacy behavior.
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
      // F4-P0-05: guarded write — never revert a run another owner already
      // settled terminal. The stale-running-detected path is reachable by a
      // worker resuming a job whose previous owner crashed mid-node.
      await repositories.updateWorkflowInstanceStatusIfActive(
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
    const fallbackGateCheckpoint = current.status === 'needs-revision' && completedAgentRun &&
      resumableLease?.nodeId === node.id && hasPendingFallbackGate(
        await repositories.listAuditEvents(runId), node.id, resumableLease.id,
      );
    const resumeFromGate =
      fallbackGateCheckpoint || current.status === 'awaiting-gate' ||
      (Boolean(resumableLease) &&
        ['paused', 'running'].includes(current.status) &&
        completedAgentRun);

    if (resumeFromGate) {
      if (current.status === 'paused' || fallbackGateCheckpoint) {
        // A newly persisted fallback lease may precede its Gate checkpoint.
        await repositories.transitionNode(node.id, 'running');
        await repositories.transitionNode(node.id, 'awaiting-gate');
      } else if (current.status === 'running') {
        await repositories.transitionNode(node.id, 'awaiting-gate');
      }
      await repositories.updateWorkflowInstanceStatusIfActive(
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
      await repositories.updateWorkflowInstanceStatusIfActive(
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
        // A blocked/interrupted source execution still owns its working edits.
        // Reuse only that source lease; repair aliases belong to another node.
        const lease = resumableLease?.runId === runId &&
          resumableLease.nodeId === node.id && resumableLease.role === node.role &&
          !resumableLease.releasedAt
          ? resumableLease
          : await leaseService.createExecutionLease(runId, node);
        if (deps.signal?.aborted) {
          await repositories.markRoleRunInterrupted({
            roleRunId,
            interruptedAt: new Date().toISOString(),
          });
          // Ownership-lost fencing: another owner recovered this job and is
          // authoritative. This fenced executor must NOT touch the shared node
          // or workflow rows — doing so could revert the new owner's terminal
          // state (terminal-state monotonicity). Clean up only our own
          // role_run (done above) and stand down.
          if (isJobOwnershipLostAbort(deps.signal)) {
            await audit.append({
              runId,
              type: 'node.interrupted',
              payload: {
                nodeId: node.id,
                error: 'job ownership lost before agent start (fenced)',
              },
            });
            return false;
          }
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
            // Genuine interrupt (no fencing signal): guard the write so it can
            // never overwrite a terminal status.
            await repositories.updateWorkflowInstanceStatusIfActive(
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
                : 'interrupted before agent start',
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
            // Ownership-lost fencing: the new owner is authoritative. Stand
            // down without side effects — do NOT touch shared node/workflow
            // rows (would revert its terminal state) and do NOT finalize the
            // lease (commit + promote would push this stale worktree onto the
            // run branch the new owner already owns). Our own role_run is
            // marked interrupted above.
            if (!isJobOwnershipLostAbort(deps.signal)) {
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
                // Genuine interrupt: guarded write never overwrites terminal.
                await repositories.updateWorkflowInstanceStatusIfActive(
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
        }
      } catch (error) {
        // A terminal-status conflict must propagate to the executor (which
        // maps it to job cancelled), never be swallowed into `interrupted`.
        if (isWorkflowTerminalError(error)) {
          throw error;
        }
        // Ownership-lost fencing: stand down without touching shared node or
        // workflow rows — the recovering owner is authoritative and may have
        // already settled a terminal status we must not revert.
        if (isJobOwnershipLostAbort(deps.signal)) {
          await audit.append({
            runId,
            type: 'node.interrupted',
            payload: {
              nodeId: node.id,
              error: 'job ownership lost (fenced)',
            },
          });
          return false;
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
          // Genuine interrupt: guarded write never overwrites terminal.
          await repositories.updateWorkflowInstanceStatusIfActive(
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
    // A completed Agent is resumable at its Gates. Shutdown/cancellation must
    // leave that checkpoint and lease intact; repair may instead have left the
    // source needs-revision, which must also remain truthful for recovery.
    async function stopAbortedGateExecution(): Promise<boolean> {
      if (!deps.signal?.aborted) return false;
      if (isJobOwnershipLostAbort(deps.signal)) return true;
      if (isJobCancellationAbort(deps.signal)) {
        await writeWorkflowTerminal(repositories, runId, 'cancelled', node.id);
      } else {
        await repositories.updateWorkflowInstanceStatusIfActive(runId, 'interrupted', node.id);
      }
      return true;
    }

    const configuredGates = gatesWithStableKeys(node.gates, node.id);
    try {
      for (const gate of configuredGates) {
        if (await stopAbortedGateExecution()) return false;
        const passed = await gateRunner.runGateWithRepair(runId, node, gate);
        if (await stopAbortedGateExecution()) return false;
        if (!passed) {
          return false;
        }
      }
    } catch (error) {
      if (await stopAbortedGateExecution()) {
        await audit.append({
          runId,
          type: 'gate.execution.interrupted',
          payload: {
            nodeId: node.id,
            reason: isJobOwnershipLostAbort(deps.signal)
              ? 'ownership-lost'
              : isJobShutdownAbort(deps.signal) ? 'shutdown' : 'cancelled',
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return false;
      }
      await repositories.transitionNode(node.id, 'interrupted');
      // Guarded: never overwrite a terminal status settled by another writer.
      await repositories.updateWorkflowInstanceStatusIfActive(
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
      if (await stopAbortedGateExecution()) return false;
      await helpers.recordQaValidationRef(runId, node);
      if (await stopAbortedGateExecution()) return false;
      await leaseService.finalizeExecutionLease(runId, node.id);
    } catch (error) {
      if (await stopAbortedGateExecution()) return false;
      await repositories.transitionNode(node.id, 'interrupted');
      // Guarded: never overwrite a terminal status settled by another writer.
      await repositories.updateWorkflowInstanceStatusIfActive(
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

    if (await stopAbortedGateExecution()) return false;
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

// An ordinary failed repair can persist its replacement source lease before
// shutdown prevents the node checkpoint. A later repair intent supersedes it.
export function hasPendingFallbackGate(
  events: Pick<AuditEvent, 'type' | 'payload'>[], nodeId: string, leaseId: string,
): boolean {
  const created = events.map(event => event.type === 'worktree.lease.created' &&
    event.payload.nodeId === nodeId && event.payload.leaseId === leaseId).lastIndexOf(true);
  const failed = events.map(event => event.type === 'gate.repair.failed' && event.payload.nodeId === nodeId).lastIndexOf(true);
  const intent = events.map(event => event.type === 'gate.repair.intent' && event.payload.sourceNodeId === nodeId).lastIndexOf(true);
  return failed >= 0 && created > failed && created > intent;
}
