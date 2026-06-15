import { join } from 'node:path';

import type {
  GateConfig,
  GateResult,
} from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentAdapter } from '../runtime/agent-adapter.js';
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
  formatGateResultForPrompt(gate: GateResult): string;
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
    const cwd = executionLeases.get(nodeId)?.worktreePath ?? repoPath;
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

  function formatGateResultForPrompt(gate: GateResult): string {
    return `- gateResultId: ${gate.id} (context only: nodeId=${gate.nodeId}; gateType=${gate.gateType}; status=${gate.status})`;
  }

  async function runGateWithRepair(
    runId: string,
    node: ExecutableNode,
    gate: WorkflowGateConfig,
    gateOpts?: { forceRerun?: boolean },
  ): Promise<boolean> {
    const checkedTransitionNode = getCheckedTransition();
    const reworkHandler = getReworkHandler();

    if (!gateOpts?.forceRerun) {
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
    let result = await runGate(runId, node.id, gate);
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
        await repositories.transitionNode(node.id, 'needs-revision');
        await leaseService.finalizeExecutionLease(runId, node.id);
        const repairNode = await gateEngine.createAutoFixRepairNode({
          failedGateResult: result,
          fixerRole: node.role,
        });
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
        await repositories.transitionNode(repairNode.id, 'running');
        let repairSucceeded = false;
        try {
          const repairLease = await leaseService.createExecutionLease(runId, {
            id: repairNode.id,
            role: repairNode.role,
            phaseId: repairNode.phaseId,
          });
          try {
            const repairResult = await adapter.runAgent(
              await helpers.agentInputForLease(
                runId,
                {
                  id: repairNode.id,
                  role: repairNode.role,
                  phaseId: repairNode.phaseId,
                },
                repairLease,
                await promptBuilder.buildRepairPrompt(
                  runId,
                  repairNode,
                  result,
                ),
              ),
            );
            assertSuccessfulAgentRun(repairResult);
            repairSucceeded = true;
          } finally {
            if (!repairSucceeded) {
              await leaseService
                .finalizeExecutionLease(runId, repairNode.id)
                .catch(() => {});
            }
          }
        } catch (error) {
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
          result = await runGate(runId, node.id, gate);
          if (result.status === 'passed' || result.status === 'skipped') {
            repairPassed = true;
          }
          continue;
        }
        await repositories.transitionNode(repairNode.id, 'passed');
        const repairLease = await leaseService.activeExecutionLease(
          runId,
          repairNode.id,
        );
        if (repairLease) {
          executionLeases.set(node.id, repairLease);
        }
        await repositories.transitionNode(node.id, 'running');
        await repositories.transitionNode(node.id, 'awaiting-gate');
        result = await runGate(runId, node.id, gate);
        if (result.status === 'passed' || result.status === 'skipped') {
          repairPassed = true;
        }
      }

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
          reworkAttempt++;
          await audit.append({
            runId,
            type: 'gate.rework.attempt',
            payload: {
              nodeId: node.id,
              targetNodeId,
              attempt: reworkAttempt,
              maxAttempts: maxReworkAttempts,
            },
          });

          await reworkHandler.attemptChangesRequestedRework(
            runId,
            node,
            gate,
            result,
            targetNodeId,
            reworkAttempt,
          );

          result = await runGate(runId, node.id, gate);
          if (result.status === 'passed' || result.status === 'skipped') {
            reworkPassed = true;
          }
        }

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
    await repositories.updateWorkflowInstanceStatus(
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
    formatGateResultForPrompt,
    isFirstHumanGate,
  };
}
