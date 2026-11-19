import type { TekonRepositories } from '../db/repositories.js';
import type { GateResult, Node, Role } from '../types/domain.js';
import { deriveRepairNode } from './execution-plan.js';

/**
 * Creates the pending repair node for a failed autoFix gate. It belongs to the
 * workflow, not to the gate engine: a gate only reports a result, and the
 * workflow decides whether that result turns into a repair node.
 */
export function createAutoFixRepairNode(
  repositories: TekonRepositories,
  input: { failedGateResult: GateResult; fixerRole: Role },
): Promise<Node> {
  const now = new Date().toISOString();
  const derived = deriveRepairNode(input.failedGateResult.nodeId, input.failedGateResult.id, input.fixerRole);
  return repositories.createNode({
    id: derived.id,
    runId: input.failedGateResult.runId,
    role: derived.role,
    status: 'pending',
    inputs: derived.inputs,
    outputs: derived.outputs,
    gates: derived.gates,
    dependencies: derived.dependsOn,
    order: 0,
    createdAt: now,
    updatedAt: now,
  });
}
