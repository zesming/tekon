import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';

import { createArtifactStore } from '../artifact/store.js';
import type { AuditLogger } from '../audit/logger.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  hashAdmissionEnvelope,
  isValidRequestId,
  type PreparedAdmissionData,
  type RunAdmissionRow,
} from '../db/admission-store.js';
import { createGateEngine, type GateEngine } from '../gate/engine.js';
import type { AgentAdapter, AgentRunResult } from '../runtime/agent-adapter.js';
import type { AgentEventSink } from '../runtime/agent-step-events.js';
import { createCommandGateway } from '../runtime/command-gateway.js';
import type { SubprocessRegistry } from '../session/subprocess-registry.js';
import {
  isJobOwnershipLostAbort,
  isJobShutdownAbort,
} from '../session/job-runner.js';
import type { WorktreeLease } from '../types/config.js';
import type { WorktreeManager } from '../runtime/worktree-manager.js';
import type { WorkflowInstance } from '../types/domain.js';
import { WorkflowTerminalError } from './errors.js';
import { RunAdmissionError } from './admission-error.js';
import {
  assertWorkflowTransition,
  isTerminalWorkflowStatus,
  writeWorkflowTerminal,
} from './state-machine.js';
import { loadWorkflowTemplate, type WorkflowTemplate } from './template.js';

// Sub-modules
import { createLeaseService } from './lease-service.js';
import { createPromptBuilder } from './prompt-builder.js';
import { createWorkflowHelpers } from './helpers.js';
import { createReworkHandler } from './rework.js';
import { createGateRunner } from './gate-runner.js';
import { createNodeExecutor } from './node-executor.js';
import {
  runPlanToExecutionPlan,
  buildPreparedRun as buildRunPlan,
  validateAndBuildExecutionPlan,
} from './execution-plan.js';
import type { RunPlan } from './run-plan.js';
import { captureRepoCommands } from './repo-command-binding.js';

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
  requestId?: string;
  profile?: string;
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
  planSnapshot?: string;
  planDigest?: string;
  canonicalPlan?: RunPlan;
}

export interface WorkflowEngineResult {
  runId: string;
  workflow: WorkflowInstance;
}

export interface WorkflowEngine {
  /** Pure validated descriptor; only the admission transaction persists it. */
  buildPreparedRun(input: WorkflowEngineStartInput): PreparedAdmissionData;
  prepareRun(
    input: WorkflowEngineStartInput,
  ): Promise<WorkflowEnginePreparedResult>;
  executePreparedRun(runId: string): Promise<WorkflowInstance>;
  startRun(input: WorkflowEngineStartInput): Promise<WorkflowEnginePreparedResult>;
  resumeRun(runId: string): Promise<WorkflowEngineResult>;
}

export interface WorkflowEnginePreparedResult extends WorkflowEngineResult {
  requestId: string;
  replayed: boolean;
  filesState: RunAdmissionRow['filesState'];
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
  profile?: string;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  progressHeartbeatMs?: number;
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
  planSnapshot?: string;
  planDigest?: string;
  canonicalPlan?: RunPlan;
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
    getSignal: () => options.signal,
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
    buildPreparedRun: buildAdmissionData,
    prepareRun,
    executePreparedRun,

    async startRun(input) {
      const prepared = await prepareRun(input);
      // 只有新事务赢家可自动执行；重放只观察原运行，不能成为隐式resume。
      if (prepared.replayed || prepared.filesState !== 'ready') return prepared;
      try {
        const workflow = await executePreparedRun(prepared.runId);
        return { ...prepared, workflow };
      } catch (error) {
        throw new RunAdmissionError(prepared.requestId, error, {
          runId: prepared.runId, sessionId: null, jobId: null, filesState: prepared.filesState,
        });
      }
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

      await assertAdmissionReady(runId);
      const plan = await validateAndBuildExecutionPlan(runId, options.repositories, options.audit);

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

      const workflow = await executePlan(runId, plan);
      return { runId, workflow };
    },
  };

  // Capture serializable execution settings before crossing an async boundary.
  // Runtime handles (adapter, repositories, bus, signals) are intentionally not
  // submission data; explicit executable/config/base/plan options are.
  function executionSettings() {
    return structuredClone({
      repoPath: options.repoPath,
      dataDir: options.dataDir,
      baseRef: options.baseRef,
      allowDirtyBase: options.allowDirtyBase,
      agentProvider: options.agentProvider,
      agentConfigSummary: options.agentConfigSummary,
      builtInRolesDir: options.builtInRolesDir,
      userHome: options.userHome,
      profile: options.profile,
      timeoutMs: options.timeoutMs,
      noProgressTimeoutMs: options.noProgressTimeoutMs,
      progressHeartbeatMs: options.progressHeartbeatMs,
      canonicalPlan: options.canonicalPlan,
      planDigest: options.planDigest,
      planSnapshot: options.planSnapshot,
    });
  }

  function requestIdentity(
    input: WorkflowEngineStartInput,
    settings: ReturnType<typeof executionSettings>,
  ) {
    const requestId = input.requestId ?? randomUUID();
    if (!isValidRequestId(requestId)) throw new Error('REQUEST_ID_INVALID');
    const { requestId: _requestId, ...intent } = input;
    return {
      requestId,
      envelopeHash: hashAdmissionEnvelope({
        version: 1,
        scope: realpathSync(settings.repoPath),
        demandTextOrRef: input.demandText,
        mode: input.kind ?? 'workflow',
        surface: 'core',
        intent,
        execution: settings,
      }),
    };
  }

  function buildAdmissionData(
    rawInput: WorkflowEngineStartInput,
    settings = executionSettings(),
  ): PreparedAdmissionData {
    const input = structuredClone(rawInput);
    const identity = requestIdentity(input, settings);
    const workflowSpec = input.workflowSpec ?? loadWorkflowTemplate({
      name: input.templateName ?? (input.kind === 'goal' ? 'goal' : 'standard-delivery'),
    });
    const repoCommands = captureRepoCommands(settings.repoPath, workflowSpec);
    const prepared = buildRunPlan({ ...input, workflowSpec }, { ...settings, profile: input.profile ?? settings.profile, repoCommands });
    const runId = `run_${randomUUID()}`;
    const execution = runPlanToExecutionPlan(prepared.canonicalPlan, runId);
    return {
      ...identity,
      envelopeVersion: 1,
      runId,
      projectId: `project_${randomUUID()}`,
      projectName: 'tekon',
      repoPath: realpathSync(settings.repoPath),
      dataDir: settings.dataDir,
      demandId: `demand_${randomUUID()}`,
      demandTitle: input.demandText.slice(0, 80),
      demandBody: input.demandText,
      demandSource: input.mode,
      workflowKind: prepared.kind,
      allowDirtyBase: settings.allowDirtyBase ?? false,
      planSnapshot: prepared.planSnapshot,
      planDigest: prepared.planDigest,
      ...(settings.agentProvider ? { providerSnapshot: {
        provider: settings.agentProvider,
        configSummary: settings.agentConfigSummary ?? {},
      } } : {}),
      phases: execution.phases.map((phase, phaseIndex) => ({
        id: phase.id,
        name: phase.name,
        order: phaseIndex,
        nodes: phase.nodes.map((node, nodeIndex) => ({
          id: node.id,
          role: node.role,
          order: nodeIndex,
          inputs: node.inputs,
          outputs: node.outputs,
          gates: node.gates,
          dependencies: node.dependsOn,
        })),
      })),
      templateId: prepared.template.id,
    };
  }

  async function prepareRun(
    rawInput: WorkflowEngineStartInput,
  ): Promise<WorkflowEnginePreparedResult> {
    const requestId = rawInput.requestId ?? randomUUID();
    if (!isValidRequestId(requestId)) throw new Error('REQUEST_ID_INVALID');
    const store = options.repositories.admissionStore;
    let envelopeHash: string | undefined;
    let knownAdmission: RunAdmissionRow | undefined;
    async function lookup(): Promise<WorkflowEnginePreparedResult | null> {
      const existing = await store.getAdmission(requestId);
      if (!existing) return null;
      if (existing.envelopeHash !== envelopeHash) throw new Error('REQUEST_ID_CONFLICT');
      knownAdmission = existing;
      const admission = existing.filesState === 'ready'
        ? existing : await store.recoverAdmissionFiles(existing.requestId);
      knownAdmission = admission;
      return {
        requestId: admission.requestId,
        runId: admission.runId,
        workflow: await helpers.mustGetWorkflow(admission.runId),
        replayed: true,
        filesState: admission.filesState,
      };
    }
    try {
      const input = structuredClone({ ...rawInput, requestId });
      const settings = executionSettings();
      envelopeHash = requestIdentity(input, settings).envelopeHash;
      const existing = await lookup();
      if (existing) return existing;
      const outcome = await store.admitRun(buildAdmissionData(input, settings));
      return {
        requestId: outcome.requestId,
        runId: outcome.runId,
        workflow: outcome.workflow,
        replayed: outcome.outcome === 'already_admitted',
        filesState: outcome.filesState,
      };
    } catch (error) {
      if (envelopeHash !== undefined) {
        try {
          const winner = await lookup();
          if (winner) return winner;
        } catch (lookupError) {
          if (lookupError instanceof Error && lookupError.message === 'REQUEST_ID_CONFLICT') {
            throw new RunAdmissionError(requestId, lookupError);
          }
        }
      }
      throw new RunAdmissionError(requestId, error, knownAdmission);
    }
  }

  async function assertAdmissionReady(runId: string): Promise<void> {
    const admission = await options.repositories.admissionStore?.getAdmissionByRunId(runId);
    if (admission && admission.filesState !== 'ready') {
      throw new Error(`ADMISSION_RECOVERY_REQUIRED: requestId=${admission.requestId} runId=${runId}`);
    }
  }

  async function executePreparedRun(runId: string): Promise<WorkflowInstance> {
    await assertAdmissionReady(runId);
    const plan = await validateAndBuildExecutionPlan(runId, options.repositories, options.audit);
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
        // F4-P0-02: classify the abort. An ownership-lost fence means another
        // owner recovered this job and is authoritative — this stale executor
        // must stand down WITHOUT writing the shared workflow row (writing
        // `cancelled` here would terminate a run the new owner is still
        // executing, and the new owner's later `passed` write would then throw
        // a terminal conflict, discarding real work). Only a genuine user
        // cancel settles `cancelled`.
        if (options.signal?.aborted) {
          if (isJobOwnershipLostAbort(options.signal)) {
            return helpers.mustGetWorkflow(runId);
          }
          if (isJobShutdownAbort(options.signal)) {
            await options.repositories.updateWorkflowInstanceStatusIfActive(
              runId,
              'interrupted',
              node.id,
            );
            return helpers.mustGetWorkflow(runId);
          }
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
    // F4-P0-02: same classification as the node boundary — an ownership-lost
    // fence stands down (the recovering owner writes the terminal state),
    // only a genuine cancel settles `cancelled`.
    if (options.signal?.aborted) {
      if (isJobOwnershipLostAbort(options.signal)) {
        return helpers.mustGetWorkflow(runId);
      }
      if (isJobShutdownAbort(options.signal)) {
        await options.repositories.updateWorkflowInstanceStatusIfActive(
          runId,
          'interrupted',
          null,
        );
        return helpers.mustGetWorkflow(runId);
      }
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
