import { join } from 'node:path';

import type {
  GateConfig,
  GateResult,
} from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentAdapter } from '../runtime/agent-adapter.js';
import {
  runAgentWithStepEvents,
  type AgentEventSink,
} from '../runtime/agent-step-events.js';
import type { GateEngine } from '../gate/engine.js';
import type { WorktreeLease } from '../types/config.js';
import { loadRepoProfile, repoProfileCommandResolution } from '../repo/profile.js';
import {
  type WorkflowGateConfig,
} from './template.js';
import {
  type CheckedTransitionFn,
  type ExecutableNode,
  defaultCommandPolicy,
  gatesWithStableKeys,
  isChangesRequested,
  resolveMaxReworkAttempts,
} from './workflow-runtime.js';
import type { LeaseService } from './lease-service.js';
import type { WorkflowHelpers } from './helpers.js';
import { assertSuccessfulAgentRun } from './helpers.js';
import type { PromptBuilder } from './prompt-builder.js';
import type { ReworkHandler } from './rework.js';
import { isJobOwnershipLostAbort, isJobShutdownAbort } from '../session/job-runner.js';

export interface GateRunnerDeps {
  repoPath: string;
  dataDir: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  adapter: AgentAdapter;
  gateEngine: GateEngine;
  leaseService: LeaseService;
  helpers: WorkflowHelpers;
  promptBuilder: PromptBuilder;
  executionLeases: Map<string, WorktreeLease>;
  getCheckedTransition(): CheckedTransitionFn;
  getReworkHandler(): ReworkHandler;
  /**
   * Job-level lifecycle signal shared with node-executor. Any abort stops Gate
   * success, repair, and exhaustion; ownership loss also fences shared writes.
   * Absent means legacy/standalone Gate execution without lifecycle fencing.
   */
  getSignal?(): AbortSignal | undefined;
  /**
   * Phase 2 S3 (review S1): best-effort agent-loop event sink. The gate-repair
   * agent (runGateWithRepair) is a real agent execution — it emits step events
   * too, so a run that went through gate repair has a complete model-visible
   * replay (§13.6). Threaded from the engine like node-executor/rework.
   */
  agentEventSink?: AgentEventSink;
}

export interface GateRunner {
  runGateWithRepair(
    runId: string,
    node: ExecutableNode,
    gate: WorkflowGateConfig,
    gateOpts?: { forceRerun?: boolean },
  ): Promise<boolean>;
  latestGateResult(
    runId: string,
    nodeId: string,
    gateType: GateConfig['type'],
    gateKey?: string,
    allowLegacyHumanFallback?: boolean,
  ): Promise<GateResult | undefined>;
  latestGateResultsForNode(
    gates: GateResult[],
    nodeId: string,
  ): Record<string, GateResult['status']>;
  isFirstHumanGate(
    gates: WorkflowGateConfig[],
    gateKey?: string,
  ): boolean;
}

export function createGateRunner(deps: GateRunnerDeps): GateRunner {
  const {
    repoPath,
    dataDir,
    repositories,
    audit,
    adapter,
    gateEngine,
    leaseService,
    helpers,
    promptBuilder,
    executionLeases,
    getCheckedTransition,
    getReworkHandler,
  } = deps;

  async function runGate(
    runId: string,
    nodeId: string,
    gate: WorkflowGateConfig,
  ): Promise<GateResult> {
    const lease = await leaseService.activeExecutionLease(runId, nodeId, { required: true });
    if (deps.getSignal?.()?.aborted) throw new Error('Gate execution aborted before command start');
    const cwd = lease?.worktreePath ?? repoPath;
    const resolvedGate = resolveGateCommand(gate);
    return gateEngine.runGate({
      runId,
      nodeId,
      gate: resolvedGate as GateConfig,
      cwd,
      artifactRoot: repoPath,
      outputDir: join(repoPath, dataDir, 'runs', runId, 'gates'),
      policy: defaultCommandPolicy(cwd),
    });
  }

  function resolveGateCommand(gate: WorkflowGateConfig): WorkflowGateConfig {
    if (!gate.commandRef || gate.command) {
      return gate;
    }
    const profile = loadRepoProfile(repoPath);
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

  async function latestGateResult(
    runId: string,
    nodeId: string,
    gateType: GateConfig['type'],
    gateKey?: string,
    allowLegacyHumanFallback = false,
  ): Promise<GateResult | undefined> {
    const matchingResults = (
      await repositories.listGateResults(runId)
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

  async function runGateWithRepair(
    runId: string,
    node: ExecutableNode,
    gate: WorkflowGateConfig,
    gateOpts?: { forceRerun?: boolean },
  ): Promise<boolean> {
    const checkedTransitionNode = getCheckedTransition();
    const reworkHandler = getReworkHandler();

    // Gate results describe command quality; executor aborts describe lifecycle.
    // Classify lifecycle first, including late success, before any repair or settle.
    let result: GateResult | undefined;
    async function interrupted(): Promise<boolean> {
      const signal = deps.getSignal?.();
      if (!signal?.aborted) return false;
      await audit.append({
        runId,
        type: 'gate.execution.interrupted',
        payload: {
          nodeId: node.id,
          gateType: gate.type,
          gateKey: gate.gateKey,
          gateResultId: result?.id,
          reason: isJobOwnershipLostAbort(signal)
            ? 'ownership-lost'
            : isJobShutdownAbort(signal) ? 'shutdown' : 'cancelled',
        },
      });
      return true;
    }
    if (await interrupted()) return false;

    if (!gateOpts?.forceRerun) {
      const existingResult = await latestGateResult(
        runId,
        node.id,
        gate.type,
        gate.gateKey,
        gate.type === 'human' && isFirstHumanGate(node.gates, gate.gateKey),
      );
      if (await interrupted()) return false;
      if (
        existingResult?.status === 'passed' ||
        existingResult?.status === 'skipped'
      ) {
        await audit.append({
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
    }

    if (gate.type === 'qa-signoff') {
      await helpers.recordQaValidationRef(runId, node);
    }
    if (await interrupted()) return false;
    result = await runGate(runId, node.id, gate);
    if (await interrupted()) return false;
    if (result.status === 'passed' || result.status === 'skipped') {
      await audit.append({
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
      await audit.append({
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
        if (await interrupted()) return false;
        const repairNodeId = `repair_${result.id}`;
        await audit.append({
          runId,
          type: 'gate.repair.intent',
          payload: {
            sourceNodeId: node.id,
            repairNodeId,
            gateResultId: result.id,
            gateType: gate.type,
            gateKey: gate.gateKey,
            fixerRole: node.role,
            attempt: retryAttempt,
            maxAttempts: gate.maxRetries,
          },
        });
        if (await interrupted()) return false;
        await repositories.transitionNode(node.id, 'needs-revision');
        if (await interrupted()) return false;
        await leaseService.finalizeExecutionLease(runId, node.id);
        if (await interrupted()) return false;
        const repairNode = await gateEngine.createAutoFixRepairNode({
          failedGateResult: result,
          fixerRole: node.role,
        });
        if (await interrupted()) return false;
        await audit.append({
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
        if (await interrupted()) return false;
        await repositories.transitionNode(repairNode.id, 'running');
        if (await interrupted()) return false;
        let repairSucceeded = false;
        let repairFinalizationFailed = false;
        try {
          const repairLease = await leaseService.createExecutionLease(runId, {
            id: repairNode.id,
            role: repairNode.role,
            phaseId: repairNode.phaseId,
          });
          try {
            if (await interrupted()) return false;
            const repairInput = await helpers.agentInputForLease(
              runId,
              {
                id: repairNode.id,
                role: repairNode.role,
                phaseId: repairNode.phaseId,
              },
              repairLease,
              await promptBuilder.buildRepairPrompt(runId, repairNode, result),
            );
            if (await interrupted()) return false;
            repairInput.signal = deps.getSignal?.();
            const repairResult = await runAgentWithStepEvents(
              adapter,
              repairInput,
              {
                runId,
                nodeId: repairNode.id,
                role: repairNode.role,
                promptSummary: repairInput.prompt,
              },
              deps.agentEventSink,
            );
            if (await interrupted()) return false;
            assertSuccessfulAgentRun(repairResult);
            repairSucceeded = true;
          } finally {
            if (!repairSucceeded) {
              // Aborted repair work remains available for explicit recovery;
              // do not commit/promote work from a stopped or fenced executor.
              if (!deps.getSignal?.()?.aborted) {
                try {
                  await leaseService.finalizeExecutionLease(runId, repairNode.id);
                } catch (error) {
                  repairFinalizationFailed = true;
                  throw error;
                }
              }
            }
          }
        } catch (error) {
          if (await interrupted()) return false;
          // A failed promotion/release is not a completed repair attempt. Keep
          // its real error and stop before creating another execution lease.
          if (repairFinalizationFailed) throw error;
          await repositories.transitionNode(
            repairNode.id,
            'interrupted',
          );
          await audit.append({
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
          if (await interrupted()) return false;
          // Both previous leases were finalized. Check the promoted Run branch
          // in a new source lease; never run the fallback Gate in repoPath.
          await leaseService.createExecutionLease(runId, node);
          if (await interrupted()) return false;
          await repositories.transitionNode(node.id, 'running');
          if (await interrupted()) return false;
          await repositories.transitionNode(node.id, 'awaiting-gate');
          if (await interrupted()) return false;
          result = await runGate(runId, node.id, gate);
          if (await interrupted()) return false;
          if (result.status === 'passed' || result.status === 'skipped') {
            repairPassed = true;
          }
          continue;
        }
        if (await interrupted()) return false;
        await repositories.transitionNode(repairNode.id, 'passed');
        const repairLease = await leaseService.activeExecutionLease(
          runId,
          repairNode.id,
        );
        if (await interrupted()) return false;
        if (repairLease) {
          executionLeases.set(node.id, repairLease);
        }
        await repositories.transitionNode(node.id, 'running');
        if (await interrupted()) return false;
        await repositories.transitionNode(node.id, 'awaiting-gate');
        if (await interrupted()) return false;
        result = await runGate(runId, node.id, gate);
        if (await interrupted()) return false;
        if (result.status === 'passed' || result.status === 'skipped') {
          repairPassed = true;
        }
      }

      if (await interrupted()) return false;
      if (repairPassed) {
        await audit.append({
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

    if (await interrupted()) return false;
    const shouldRework = isChangesRequested(
      result.failureClassification,
      gate.type,
    );

    if (shouldRework) {
      const targetNodeId = await reworkHandler.resolveReviewTargetNode(
        runId,
        node.id,
      );
      if (targetNodeId) {
        const maxReworkAttempts = resolveMaxReworkAttempts(gate.maxRetries);
        let reworkAttempt = 0;
        let reworkPassed = false;

        while (reworkAttempt < maxReworkAttempts && !reworkPassed) {
          if (await interrupted()) return false;
          reworkAttempt++;
          await audit.append({
            runId,
            type: 'gate.rework.attempt',
            payload: {
              nodeId: node.id,
              reviewNodeId: node.id,
              targetNodeId,
              reworkNodeId: `${targetNodeId}_rework_${reworkAttempt}`,
              attempt: reworkAttempt,
              maxAttempts: maxReworkAttempts,
              gateResultId: result.id,
            },
          });

          if (await interrupted()) return false;
          await reworkHandler.attemptChangesRequestedRework(
            runId,
            node,
            gate,
            result,
            targetNodeId,
            reworkAttempt,
          );

          if (await interrupted()) return false;
          result = await runGate(runId, node.id, gate);
          if (await interrupted()) return false;
          if (result.status === 'passed' || result.status === 'skipped') {
            reworkPassed = true;
          }
        }

        if (await interrupted()) return false;
        if (reworkPassed) {
          await audit.append({
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
    if (await interrupted()) return false;
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
    await repositories.updateWorkflowInstanceStatusIfActive(
      runId,
      exhaustedNodeStatus,
      node.id,
    );
    return false;
  }

  return {
    runGateWithRepair,
    latestGateResult,
    latestGateResultsForNode,
    isFirstHumanGate,
  };
}
