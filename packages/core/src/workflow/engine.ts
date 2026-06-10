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
          name: input.templateName ?? 'standard-feature',
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
    for (const gate of node.gates) {
      const passed = await runGateWithRepair(runId, node, gate);
      if (!passed) {
        return false;
      }
    }

    try {
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
    await options.audit.append({
      runId,
      type: 'node.passed',
      payload: { nodeId: node.id },
    });
    return true;
  }

  async function runGateWithRepair(
    runId: string,
    node: ExecutableNode,
    gate: WorkflowGateConfig,
  ): Promise<boolean> {
    const existingResult = await latestGateResult(runId, node.id, gate.type);
    if (
      existingResult?.status === 'passed' ||
      existingResult?.status === 'skipped'
    ) {
      await options.audit.append({
        runId,
        type: 'gate.previously-passed',
        payload: { nodeId: node.id, gateType: gate.type },
      });
      return true;
    }

    let result = await runGate(runId, node.id, gate);
    if (result.status === 'passed' || result.status === 'skipped') {
      await options.audit.append({
        runId,
        type: 'gate.passed',
        payload: { nodeId: node.id, gateType: gate.type },
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
          payload: { nodeId: node.id, gateType: gate.type },
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
  ): Promise<GateResult | undefined> {
    return (await options.repositories.listGateResults(runId))
      .filter(
        (result) => result.nodeId === nodeId && result.gateType === gateType,
      )
      .at(-1);
  }

  async function agentInputForLease(
    runId: string,
    node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId'> & {
      outputs?: WorkflowArtifactOutputRef[];
      gates?: WorkflowGateConfig[];
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
    return {
      roleConfig: { role: node.role },
      prompt: appendArtifactProtocol(prompt, {
        outputDir,
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
      artifactStore,
      requiredArtifactTypes,
    };
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
      outputDir: string;
      requiredArtifactTypes: ArtifactType[];
    },
  ): string {
    if (input.requiredArtifactTypes.length === 0) {
      return prompt;
    }

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
      `- Write all node artifacts under TEKON_OUTPUT_DIR (${input.outputDir}).`,
      `- Required artifact types: ${input.requiredArtifactTypes.join(', ')}.`,
      '- Each artifact may be JSON, YAML front matter, or Markdown accepted by the Tekon artifact schema.',
      '- Write TEKON_ARTIFACT_MANIFEST as JSON after producing artifacts.',
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
    return buildRolePrompt({
      role,
      taskInstruction: [
        `Demand title: ${demand.title}`,
        'Demand body:',
        demand.body,
        '',
        `Execute workflow node ${node.id}.`,
        `Produce the requested artifacts and preserve evidence for gates.`,
      ].join('\n'),
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
    gates: node.gates,
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
    gates: node.gates as WorkflowGateConfig[],
    dependsOn: node.dependencies,
  };
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
