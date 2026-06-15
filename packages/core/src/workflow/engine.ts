import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createArtifactStore } from '../artifact/store.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import { createGateEngine, type GateEngine } from '../gate/engine.js';
import type { AgentAdapter, AgentRunResult } from '../runtime/agent-adapter.js';
import { createCommandGateway } from '../runtime/command-gateway.js';
import type { WorktreeLease } from '../types/config.js';
import type { WorktreeManager } from '../runtime/worktree-manager.js';
import type { WorkflowInstance } from '../types/domain.js';
import { assertWorkflowTransition } from './state-machine.js';
import {
  loadWorkflowTemplate,
  type WorkflowTemplate,
} from './template.js';

// Sub-modules
import { createLeaseService } from './lease-service.js';
import { createPromptBuilder } from './prompt-builder.js';
import { createWorkflowHelpers } from './helpers.js';
import { createReworkHandler } from './rework.js';
import { createGateRunner } from './gate-runner.js';
import { createNodeExecutor } from './node-executor.js';
import {
  templateToPlan,
  persistPlan,
  planFromRepository,
} from './execution-plan.js';

// Re-export types from sub-modules so external consumers only need engine.ts
export type { ExecutableNode, ExecutionPlan } from './workflow-runtime.js';

// Re-export utility functions from workflow-runtime
export {
  scopedId,
  gatesWithStableKeys,
  stableGateKey,
  makeSyntheticLease,
  defaultCommandPolicy,
  defaultBuiltInRolesDir,
  resolveReviewTargetNodeByHeuristic,
  isChangesRequested,
  resolveMaxReworkAttempts,
} from './workflow-runtime.js';

// Re-export assertSuccessfulAgentRun from helpers
export { assertSuccessfulAgentRun } from './helpers.js';

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

  // --- Create sub-modules ---
  const leaseService = createLeaseService({
    repoPath: options.repoPath,
    repositories: options.repositories,
    audit: options.audit,
    worktreeManager: options.worktreeManager,
    baseRef: options.baseRef,
    allowDirtyBase: options.allowDirtyBase,
    executionLeases,
  });

  const promptBuilder = createPromptBuilder({
    repoPath: options.repoPath,
    dataDir: options.dataDir,
    repositories: options.repositories,
    builtInRolesDir: options.builtInRolesDir,
    userHome: options.userHome,
    artifactStore,
  });

  const helpers = createWorkflowHelpers({
    repoPath: options.repoPath,
    dataDir: options.dataDir,
    repositories: options.repositories,
    audit: options.audit,
    worktreeManager: options.worktreeManager,
    promptBuilder,
    leaseService,
    artifactStore,
  });

  // Lazy cross-references to break circular deps between gate-runner ↔ rework
  let gateRunnerRef: ReturnType<typeof createGateRunner>;
  let reworkHandlerRef: ReturnType<typeof createReworkHandler>;

  const reworkHandler = createReworkHandler({
    repoPath: options.repoPath,
    dataDir: options.dataDir,
    repositories: options.repositories,
    audit: options.audit,
    adapter: options.adapter,
    builtInRolesDir: options.builtInRolesDir,
    userHome: options.userHome,
    leaseService,
    helpers,
    promptBuilder,
    artifactStore,
    executionLeases,
    getCheckedTransition: () => checkedTransitionNode,
    getRunGateWithRepair: () => gateRunnerRef.runGateWithRepair,
  });
  reworkHandlerRef = reworkHandler;

  const gateRunner = createGateRunner({
    repoPath: options.repoPath,
    dataDir: options.dataDir,
    repositories: options.repositories,
    audit: options.audit,
    adapter: options.adapter,
    gateEngine,
    leaseService,
    helpers,
    promptBuilder,
    executionLeases,
    getCheckedTransition: () => checkedTransitionNode,
    getReworkHandler: () => reworkHandlerRef,
  });
  gateRunnerRef = gateRunner;

  const nodeExecutor = createNodeExecutor({
    repositories: options.repositories,
    audit: options.audit,
    adapter: options.adapter,
    leaseService,
    helpers,
    promptBuilder,
    gateRunner,
    getCheckedTransition: () => checkedTransitionNode,
  });

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
    plan: import('./workflow-runtime.js').ExecutionPlan,
  ): Promise<WorkflowInstance> {
    for (const phase of plan.phases) {
      for (const node of phase.nodes) {
        const persisted = await options.repositories.getNode(node.id);
        if (persisted?.status === 'passed' || persisted?.status === 'skipped') {
          continue;
        }

        const dependencyMissing =
          await nodeExecutor.hasMissingArtifactDependency(runId, node);
        if (dependencyMissing) {
          await options.repositories.transitionNode(node.id, 'blocked');
          await options.repositories.updateWorkflowInstanceStatus(
            runId,
            'blocked',
            node.id,
          );
          return helpers.mustGetWorkflow(runId);
        }

        const completed = await nodeExecutor.executeNode(runId, node);
        if (!completed) {
          return helpers.mustGetWorkflow(runId);
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
    return passed ?? (await helpers.mustGetWorkflow(runId));
  }
}
