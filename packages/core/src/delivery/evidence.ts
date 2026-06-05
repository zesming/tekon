import type { AuditLogger } from '../audit/logger.js';
import type { DonkeyRepositories } from '../db/repositories.js';
import type {
  Artifact,
  Demand,
  GateResult,
  WorkflowInstance,
} from '../types/domain.js';

export interface DeliveryEvidencePackage {
  runId: string;
  workflowStatus: WorkflowInstance['status'];
  demand: Pick<Demand, 'id' | 'title' | 'body'>;
  artifacts: Artifact[];
  gates: GateResult[];
  audit: Awaited<ReturnType<AuditLogger['verify']>>;
  testOutputPaths: string[];
  riskGates: string[];
  rollbackPlanPresent: boolean;
}

export async function createDeliveryEvidencePackage(input: {
  repositories: DonkeyRepositories;
  audit: AuditLogger;
  runId: string;
  testOutputPaths?: string[];
  riskGates?: string[];
}): Promise<DeliveryEvidencePackage> {
  const workflow = await input.repositories.getWorkflowInstance(input.runId);
  if (!workflow) {
    throw new Error(`run not found: ${input.runId}`);
  }
  const demand = await input.repositories.getDemand(workflow.demandId);
  if (!demand) {
    throw new Error(`demand not found: ${workflow.demandId}`);
  }
  const artifacts = await input.repositories.listArtifacts(input.runId);
  const gates = await input.repositories.listGateResults(input.runId);
  const audit = await input.audit.verify(input.runId);

  return {
    runId: input.runId,
    workflowStatus: workflow.status,
    demand: {
      id: demand.id,
      title: demand.title,
      body: demand.body,
    },
    artifacts,
    gates,
    audit,
    testOutputPaths: input.testOutputPaths ?? [],
    riskGates: input.riskGates ?? [],
    rollbackPlanPresent: artifacts.some(
      (artifact) => artifact.type === 'rollback-plan',
    ),
  };
}
