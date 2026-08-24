import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createArtifactStore } from '../artifact/store.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import { createGateEngine, type GateEngine } from '../gate/engine.js';
import type { AgentAdapter, AgentRunResult } from '../runtime/agent-adapter.js';
import type { AgentEventSink } from '../runtime/agent-step-events.js';
import { createCommandGateway } from '../runtime/command-gateway.js';
import type { SubprocessRegistry } from '../session/subprocess-registry.js';
import type { WorktreeLease } from '../types/config.js';
import type { WorktreeManager } from '../runtime/worktree-manager.js';
import type { WorkflowInstance } from '../types/domain.js';
import { WorkflowTerminalError } from './errors.js';
import {
  assertWorkflowTransition,
  isTerminalWorkflowStatus,
  writeWorkflowTerminal,
} from './state-machine.js';
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
  /**
   * 4b: run kind, orthogonal to `mode` (which is the PLAN SOURCE). 'workflow'
   * (default) is a governed delivery workflow; 'goal' is a lightweight
   * single-node agent goal. Persisted on the instance so completion/resume
   * events carry the right kind.
   */
  kind?: 'workflow' | 'goal';
}

export interface WorkflowEngineResult {
  runId: string;
  workflow: WorkflowInstance;
}

export interface WorkflowEngine {
  prepareRun(
    input: WorkflowEngineStartInput,
  ): Promise<{ runId: string; workflow: WorkflowInstance }>;
  executePreparedRun(runId: string): Promise<WorkflowInstance>;
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
  /**
   * Job-level abort signal (S5). When aborted, executePlan settles the run
   * `cancelled` at the next node boundary; node-executor aborts the agent.
   * Absent = legacy synchronous behavior (CLI).
   */
  signal?: AbortSignal;
  /**
   * Pause predicate (S5). When it returns true, executePlan settles the run
   * `paused` at the next node boundary (without killing subprocesses).
   */
  isPauseRequested?: () => boolean;
  /**
   * Node-boundary checkpoint hook (S5 fencing point). Invoked once per
   * completed node, before the next node starts.
   */
  onNodeCheckpoint?: (nodeId: string) => Promise<void>;
  /**
   * Subprocess registry (S7 seam): stored so the web executor can wire it,
   * but NOT yet forwarded to the fallback gateEngine gateway. Killing
   * gate-command children on cancel needs registryKey threaded to each
   * gateway.run() at the gate-command spawn site (runCommandGate), which
   * lands in S7 (D6). Agent subprocesses are already killable via
   * AgentRunInput.signal + command-gateway registryKey (S3).
   */
  registry?: SubprocessRegistry;
  /**
   * Phase 2 S3: optional best-effort sink for agent-loop step events, threaded
   * into node-executor and rework. The web executor wires the dual-write
   * bridge; CLI omits it (no session events). MUST be best-effort (never throw)
   * — C1 governance zero-regression.
   */
  agentEventSink?: AgentEventSink;
}

export function createWorkflowEngine(
  options: CreateWorkflowEngineOptions,
): WorkflowEngine {
  const gateEngine =
    options.gateEngine ??
    createGateEngine({
      repositories: options.repositories,
      // S7 note: the subprocess registry is threaded to *agent* subprocesses
      // via AgentRunInput.signal + command-gateway registryKey (S3). Killing
      // gate-command subprocesses on cancel needs the registryKey on each
      // gateway.run() call at the gate-command spawn site (runCommandGate),
      // which the web executor wires in S7 (D6). The engine accepts `registry`
      // so that seam exists; createCommandGateway itself takes no registry.
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
    agentEventSink: options.agentEventSink,
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
    agentEventSink: options.agentEventSink,
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
    signal: options.signal,
    agentEventSink: options.agentEventSink,
  });

  return {
    prepareRun,
    executePreparedRun,

    async startRun(input) {
      const { runId } = await prepareRun(input);
      const workflow = await executePreparedRun(runId);
      return { runId, workflow };
    },

    async resumeRun(runId) {
      const existing = await options.repositories.getWorkflowInstance(runId);
      if (!existing) {
        throw new Error(`run not found: ${runId}`);
      }

      if (isTerminalWorkflowStatus(existing.status)) {
        // P1-04: resume on a terminal run is a caller error. Throw a typed
        // error (CLI/web map it to clean user-facing failures) instead of
        // returning an error object cast to WorkflowEngineResult.
        throw new WorkflowTerminalError(runId, existing.status);
      }

      // MUST-FIX1: CAS second line of defense — the pre-check above is a
      // bare read; a concurrent cancel/terminal write can land between the
      // read and this write. CAS with the re-read status closes the window.
      // undefined currentNodeId → leave the pointer as-is (matches the legacy
      // updateWorkflowInstanceStatus(runId, 'running') two-arg call).
      const casResult = await options.repositories.casWorkflowInstanceStatus(
        runId,
        existing.status,
        'running',
        undefined,
      );
      if (!casResult.changed) {
        const latest = await options.repositories.getWorkflowInstance(runId);
        if (!latest) {
          throw new Error(`run not found: ${runId}`);
        }
        if (isTerminalWorkflowStatus(latest.status)) {
          throw new WorkflowTerminalError(runId, latest.status);
        }
        // Non-terminal (e.g. already `running` from a concurrent resume):
        // continue idempotently with the latest state.
      }
      await options.audit.append({
        runId,
        type: 'run.resumed',
        payload: { kind: existing.kind },
      });

      const plan = await planFromRepository(runId, options.repositories);
      const workflow = await executePlan(runId, plan);
      return { runId, workflow };
    },
  };

  /**
   * prepareRun (S5): persist the run (demand/project/instance/plan) and emit
   * the `run.started` audit event without invoking the adapter. Returns the
   * freshly created instance (status `running`).
   */
  async function prepareRun(
    input: WorkflowEngineStartInput,
  ): Promise<{ runId: string; workflow: WorkflowInstance }> {
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
      kind: input.kind ?? 'workflow',
      // 4c: persist the lease policy on the run so the async job executor
      // rebuilds its engine with the same allow-dirty-base the run was
      // started with (the executor builds a fresh engine from the provider
      // snapshot and cannot otherwise recover this flag).
      allowDirtyBase: options.allowDirtyBase ?? false,
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
      payload: {
        templateId: template.id,
        mode: input.mode,
        kind: input.kind ?? 'workflow',
      },
    });

    return { runId, workflow: await helpers.mustGetWorkflow(runId) };
  }

  async function executePreparedRun(runId: string): Promise<WorkflowInstance> {
    const plan = await planFromRepository(runId, options.repositories);
    return executePlan(runId, plan);
  }

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
        // S5: node-boundary cancel/pause checks (before any node work).
        if (options.signal?.aborted) {
          await settleCancelled(runId, node.id);
          return helpers.mustGetWorkflow(runId);
        }
        if (options.isPauseRequested?.()) {
          return settlePaused(runId, node.id);
        }

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

        // S5: node-boundary checkpoint (fencing point).
        await options.onNodeCheckpoint?.(node.id);
      }
    }

    // Gap B: all nodes finished — re-check cancel/pause before writing
    // `passed`. Without this, a pause landing in the window between the
    // last node's top-check and the passed write would either hit an
    // illegal paused→passed transition or be silently overwritten.
    if (options.signal?.aborted) {
      await settleCancelled(runId, null);
      return helpers.mustGetWorkflow(runId);
    }
    if (options.isPauseRequested?.()) {
      return settlePaused(runId, null);
    }

    const { written, workflow } = await writeWorkflowTerminal(
      options.repositories,
      runId,
      'passed',
      null,
    );
    if (written) {
      // Duplicate execution must not produce duplicate completion events.
      await options.audit.append({
        runId,
        type: 'run.passed',
        payload: { kind: workflow.kind },
      });
    }
    return workflow;
  }

  /**
   * S5: settle the run as `cancelled` via the idempotent terminal writer
   * (M2). A concurrent cancel that already landed is a no-op
   * (written=false); a conflicting terminal status throws
   * WorkflowTerminalError for the upper executor to converge.
   */
  async function settleCancelled(
    runId: string,
    nodeId: string | null,
  ): Promise<void> {
    await writeWorkflowTerminal(options.repositories, runId, 'cancelled', nodeId);
  }

  /**
   * S5 / MUST-FIX1: settle the run as `paused` via CAS (expectedFrom =
   * `running`). If the CAS loses (a concurrent cancel/terminal write won),
   * return the current workflow without overwriting it — pause losing to
   * cancel is the correct outcome.
   */
  async function settlePaused(
    runId: string,
    nodeId: string | null,
  ): Promise<WorkflowInstance> {
    const result = await options.repositories.casWorkflowInstanceStatus(
      runId,
      'running',
      'paused',
      nodeId,
    );
    if (result.changed && result.workflow) {
      return result.workflow;
    }
    const latest = await options.repositories.getWorkflowInstance(runId);
    if (!latest) {
      throw new Error(`workflow instance not found: ${runId}`);
    }
    return latest;
  }
}
