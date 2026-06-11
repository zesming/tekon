import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
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
  Phase,
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
      assertWorkflowTransition(fromStatus, 'running');
      await options.repositories.transitionNode(node.id, 'running');
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
        const agentResult = await options.adapter.runAgent(
          await agentInputForLease(
            runId,
            node,
            lease,
            await buildNodePrompt(runId, node),
          ),
        );
        assertSuccessfulAgentRun(agentResult);
        await options.repositories.markRoleRunCompleted({
          roleRunId,
          completedAt: new Date().toISOString(),
        });
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

      await options.repositories.transitionNode(node.id, 'awaiting-gate');
    }
    const configuredGates = gatesWithStableKeys(node.gates, node.id);
    for (const gate of configuredGates) {
      const passed = await runGateWithRepair(runId, node, gate);
      if (!passed) {
        return false;
      }
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

    await options.repositories.transitionNode(node.id, 'passed');
    await appendPmoNodeCheckpoint(runId, node);
    await options.audit.append({
      runId,
      type: 'node.passed',
      payload: { nodeId: node.id },
    });
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
      await options.repositories.transitionNode(node.id, 'paused');
      await options.repositories.updateWorkflowInstanceStatus(
        runId,
        'paused',
        node.id,
      );
      await options.audit.append({
        runId,
        type: 'human.gate.pending',
        payload: { nodeId: node.id, gateResultId: result.id },
      });
      return false;
    }

    if (gate.autoFix && gate.maxRetries > 0) {
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
        },
      });
      await options.repositories.transitionNode(repairNode.id, 'running');
      try {
        const repairLease = await createExecutionLease(runId, {
          id: repairNode.id,
          role: repairNode.role,
          phaseId: repairNode.phaseId,
        });
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
      } catch (error) {
        await options.repositories.transitionNode(repairNode.id, 'interrupted');
        await options.repositories.transitionNode(node.id, 'blocked');
        await options.repositories.updateWorkflowInstanceStatus(
          runId,
          gate.onExhausted === 'pause' ? 'paused' : 'blocked',
          node.id,
        );
        await options.audit.append({
          runId,
          type: 'gate.repair.failed',
          payload: {
            nodeId: node.id,
            repairNodeId: repairNode.id,
            gateResultId: result.id,
            error: error instanceof Error ? error.message : String(error),
          },
        });
        return false;
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
        await options.audit.append({
          runId,
          type: 'gate.passed-after-repair',
          payload: {
            nodeId: node.id,
            gateType: gate.type,
            gateKey: gate.gateKey,
          },
        });
        return true;
      }
    }

    await options.repositories.transitionNode(node.id, 'blocked');
    await options.repositories.updateWorkflowInstanceStatus(
      runId,
      gate.onExhausted === 'pause' ? 'paused' : 'blocked',
      node.id,
    );
    await options.audit.append({
      runId,
      type: 'gate.failed',
      payload: {
        nodeId: node.id,
        gateType: gate.type,
        gateKey: gate.gateKey,
        gateResultId: result.id,
      },
    });
    return false;
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
  ): Promise<AgentRunInput> {
    const workflow = await mustGetWorkflow(runId);
    const outputDir = join(
      options.repoPath,
      options.dataDir,
      'runs',
      runId,
      node.id,
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
        nodeId: node.id,
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
        ['ac-evidence', 'qa-release-signoff'].includes(type),
      )
        ? [
            '- For ac-evidence and qa-release-signoff JSON artifacts, each criteriaEvidence item must include at least one evidence anchor: outputPaths pointing to a file under TEKON_OUTPUT_DIR or an existing repo path, or known gateResultIds/artifactIds.',
          ]
        : []),
      ...roleScopedReviewArtifactInstructions({
        nodeId: input.nodeId,
        role: input.role,
        nodeInputs: input.nodeInputs,
        priorNodes: input.priorNodes,
        requiredArtifactTypes: input.requiredArtifactTypes,
      }),
      '- TEKON_ARTIFACT_MANIFEST is an environment variable containing the manifest file path; write the manifest JSON to $TEKON_ARTIFACT_MANIFEST.',
      '- Do not create a file literally named TEKON_ARTIFACT_MANIFEST.',
      '- Write required artifact files and the $TEKON_ARTIFACT_MANIFEST file before optional checks or reviews.',
      ...(isCodeChangesRdNode
        ? [
            '- Do not run dependency installation, test, lint, typecheck, build, or package-manager commands before writing required code-changes artifacts and the manifest; Tekon gates run validation after artifact ingestion.',
          ]
        : []),
      '- After the $TEKON_ARTIFACT_MANIFEST file is written, stop work and exit immediately.',
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
        processCheckpointRequired
          ? 'For process-checkpoint.requiredNodes, include every prior workflow node listed above with the exact nodeId and status; do not invent, omit, rename, or reorder required nodes. Also include process-checkpoint.artifactEvidence for every listed prior node output, process-checkpoint.gateEvidence for every listed prior node gate with its gateType, gateKey, and observed passed/skipped status, and process-checkpoint.humanDecisionEvidence.pending.'
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

function assertSuccessfulAgentRun(result: AgentRunResult): void {
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

function scopedId(runId: string, id: string) {
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

function gatesWithStableKeys<T extends GateConfig | WorkflowGateConfig>(
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

function stableGateKey(
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

function makeSyntheticLease(
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

function defaultCommandPolicy(repoPath: string): CommandPolicy {
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

function defaultBuiltInRolesDir(): string {
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
