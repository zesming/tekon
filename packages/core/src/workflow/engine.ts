import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { createArtifactStore } from '../artifact/store.js';
import type { AuditLogger } from '../audit/logger.js';
import type { DonkeyRepositories } from '../db/repositories.js';
import { createGateEngine, type GateEngine } from '../gate/engine.js';
import type { AgentAdapter } from '../runtime/agent-adapter.js';
import { createCommandGateway } from '../runtime/command-gateway.js';
import type { CommandPolicy, WorktreeLease } from '../types/config.js';
import type {
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
  repositories: DonkeyRepositories;
  audit: AuditLogger;
  adapter: AgentAdapter;
  gateEngine?: GateEngine;
}

interface ExecutableNode {
  id: string;
  role: Role;
  phaseId?: string;
  inputs: WorkflowArtifactInputRef[];
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
        name: 'donkey',
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
      await options.repositories.createRoleRun({
        id: `role_run_${randomUUID()}`,
        runId,
        nodeId: node.id,
        role: node.role,
        status: 'running',
        startedAt: new Date().toISOString(),
      });
      await options.adapter.runAgent({
        roleConfig: { role: node.role },
        prompt: `Run node ${node.id}`,
        worktreeLease: makeSyntheticLease(runId, node),
        outputDir: join(
          options.repoPath,
          options.dataDir,
          'runs',
          runId,
          node.id,
        ),
        commandPolicy: defaultCommandPolicy(options.repoPath),
        runContext: {
          runId,
          nodeId: node.id,
          projectId: (await mustGetWorkflow(runId)).projectId,
          repoPath: options.repoPath,
          dataDir: options.dataDir,
        },
        artifactStore,
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
    for (const gate of node.gates) {
      const passed = await runGateWithRepair(runId, node, gate);
      if (!passed) {
        return false;
      }
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
      await options.adapter.runAgent({
        roleConfig: { role: repairNode.role },
        prompt: `Repair failed gate ${result.id}`,
        worktreeLease: makeSyntheticLease(runId, {
          id: repairNode.id,
          role: repairNode.role,
          phaseId: repairNode.phaseId,
        }),
        outputDir: join(
          options.repoPath,
          options.dataDir,
          'runs',
          runId,
          repairNode.id,
        ),
        commandPolicy: defaultCommandPolicy(options.repoPath),
        runContext: {
          runId,
          nodeId: repairNode.id,
          projectId: (await mustGetWorkflow(runId)).projectId,
          repoPath: options.repoPath,
          dataDir: options.dataDir,
        },
        artifactStore,
      });
      await options.repositories.transitionNode(repairNode.id, 'passed');
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
    return gateEngine.runGate({
      runId,
      nodeId,
      gate: gate as GateConfig,
      cwd: options.repoPath,
      outputDir: join(
        options.repoPath,
        options.dataDir,
        'runs',
        runId,
        'gates',
      ),
      policy: defaultCommandPolicy(options.repoPath),
    });
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

  async function mustGetWorkflow(runId: string): Promise<WorkflowInstance> {
    const workflow = await options.repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }
    return workflow;
  }
}

async function persistPlan(
  runId: string,
  plan: ExecutionPlan,
  repositories: DonkeyRepositories,
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
    gates: node.gates,
    dependsOn: node.dependsOn.map(
      (dependency) => nodeIdByTemplateId.get(dependency) ?? dependency,
    ),
  };
}

async function planFromRepository(
  runId: string,
  repositories: DonkeyRepositories,
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
    inputs: [],
    gates: node.gates as WorkflowGateConfig[],
    dependsOn: node.dependencies,
  };
}

function makeSyntheticLease(
  runId: string,
  node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId'>,
): WorktreeLease {
  const now = new Date().toISOString();
  return {
    id: `lease_${node.id}`,
    runId,
    nodeId: node.id,
    role: node.role,
    repoPath: '',
    worktreePath: '',
    branchName: `donkey/${runId}/${node.id}`,
    createdAt: now,
  };
}

function defaultCommandPolicy(repoPath: string): CommandPolicy {
  return {
    allow: [
      { tool: 'git', args: [] },
      { tool: 'pnpm', args: [] },
      { tool: 'npm', args: [] },
    ],
    deny: [],
    requiresHumanApproval: [],
    cwdScope: [repoPath],
    network: 'disabled',
  };
}
