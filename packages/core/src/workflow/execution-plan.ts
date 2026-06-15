import type { GateConfig, Node } from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import {
  type WorkflowGateConfig,
  type WorkflowTemplate,
  type WorkflowTemplateNode,
  type WorkflowTemplatePhase,
} from './template.js';
import {
  type ExecutableNode,
  type ExecutionPlan,
  gatesWithStableKeys,
  scopedId,
} from './workflow-runtime.js';

/**
 * Convert a workflow template into an executable plan by scoping all IDs
 * to the given runId and resolving inter-node references.
 */
export function templateToPlan(
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

/**
 * Persist an execution plan to the repository database (phases + nodes).
 */
export async function persistPlan(
  runId: string,
  plan: ExecutionPlan,
  repositories: TekonRepositories,
): Promise<void> {
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

/**
 * Reconstruct an execution plan from persisted phases and nodes.
 */
export async function planFromRepository(
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
