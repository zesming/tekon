import { join } from 'node:path';

import type { ArtifactStore } from '../artifact/store.js';
import type { ArtifactType, WorkflowInstance } from '../types/domain.js';
import type { TekonRepositories } from '../db/repositories.js';
import type { AuditLogger } from '../audit/logger.js';
import type { AgentRunInput, AgentRunResult } from '../runtime/agent-adapter.js';
import type { WorktreeLease } from '../types/config.js';
import type { WorktreeManager } from '../runtime/worktree-manager.js';
import {
  type WorkflowArtifactInputRef,
  type WorkflowArtifactOutputRef,
  type WorkflowGateConfig,
} from './template.js';
import {
  type ExecutableNode,
  defaultCommandPolicy,
} from './workflow-runtime.js';
import type { PromptBuilder } from './prompt-builder.js';
import type { LeaseService } from './lease-service.js';

export interface HelpersDeps {
  repoPath: string;
  dataDir: string;
  repositories: TekonRepositories;
  audit: AuditLogger;
  worktreeManager?: WorktreeManager;
  promptBuilder: PromptBuilder;
  leaseService: LeaseService;
  artifactStore: ArtifactStore;
}

export interface WorkflowHelpers {
  recordQaValidationRef(
    runId: string,
    node: ExecutableNode,
  ): Promise<void>;
  hasCompletedAgentRun(runId: string, nodeId: string): Promise<boolean>;
  mustGetWorkflow(runId: string): Promise<WorkflowInstance>;
  mustGetDemand(demandId: string): Promise<{
    id: string;
    title: string;
    body: string;
    [key: string]: unknown;
  }>;
  agentInputForLease(
    runId: string,
    node: Pick<ExecutableNode, 'id' | 'role' | 'phaseId'> & {
      inputs?: WorkflowArtifactInputRef[];
      outputs?: WorkflowArtifactOutputRef[];
      gates?: WorkflowGateConfig[];
      dependsOn?: string[];
    },
    lease: WorktreeLease,
    prompt: string,
    reworkTargetNodeId?: string,
  ): Promise<AgentRunInput>;
}

export function createWorkflowHelpers(deps: HelpersDeps): WorkflowHelpers {
  const {
    repoPath,
    dataDir,
    repositories,
    audit,
    worktreeManager,
    promptBuilder,
    leaseService,
    artifactStore,
  } = deps;

  async function recordQaValidationRef(
    runId: string,
    node: ExecutableNode,
  ): Promise<void> {
    if (!worktreeManager || !isQaValidationNode(node)) {
      return;
    }
    const lease = await leaseService.activeExecutionLease(runId, node.id);
    if (!lease) {
      return;
    }
    const head = await worktreeManager.getLeaseHead(lease.id);
    const ref = `sha:${head}`;
    if ((await latestQaValidationRef(runId)) === ref) {
      return;
    }
    await audit.append({
      runId,
      type: 'qa.validation.ref',
      payload: {
        nodeId: node.id,
        ref,
      },
    });
  }

  async function hasCompletedAgentRun(
    runId: string,
    nodeId: string,
  ): Promise<boolean> {
    const roleRun = await repositories.getLatestRoleRunForNode(runId, nodeId);
    return roleRun?.status === 'passed' && Boolean(roleRun.completedAt);
  }

  async function mustGetWorkflow(runId: string): Promise<WorkflowInstance> {
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }
    return workflow;
  }

  async function mustGetDemand(demandId: string) {
    const demand = await repositories.getDemand(demandId);
    if (!demand) {
      throw new Error(`demand not found: ${demandId}`);
    }
    return demand;
  }

  async function latestQaValidationRef(
    runId: string,
  ): Promise<string | undefined> {
    const events = await repositories.listAuditEvents(runId);
    return events
      .filter((event) => event.type === 'qa.validation.ref')
      .map((event) =>
        typeof event.payload.ref === 'string' ? event.payload.ref : undefined,
      )
      .filter((ref): ref is string => Boolean(ref))
      .at(-1);
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
      worktreeManager &&
      node.outputs?.some((output) => output.type === 'qa-release-signoff')
    ) {
      return `sha:${await worktreeManager.getLeaseHead(lease.id)}`;
    }
    return undefined;
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
    reworkTargetNodeId?: string,
  ): Promise<AgentRunInput> {
    const workflow = await mustGetWorkflow(runId);
    const effectiveNodeId = reworkTargetNodeId ?? node.id;
    const outputDir = join(
      repoPath,
      dataDir,
      'runs',
      runId,
      effectiveNodeId,
    );
    const requiredArtifactTypes = requiredArtifactTypesForNode(node);
    const allNodes = await repositories.listNodes(runId);
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
      prompt: promptBuilder.appendArtifactProtocol(promptWithDeliveryRef, {
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
        nodeId: effectiveNodeId,
        projectId: workflow.projectId,
        repoPath: lease.worktreePath,
        dataDir,
      },
      nodeInputs: node.inputs ?? [],
      nodeDependencies: node.dependsOn ?? [],
      deliveryRef,
      priorNodes: priorNodeContext,
      artifactStore,
      requiredArtifactTypes,
    };
  }

  return {
    recordQaValidationRef,
    hasCompletedAgentRun,
    mustGetWorkflow,
    mustGetDemand,
    agentInputForLease,
  };
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for reuse)
// ---------------------------------------------------------------------------

export function isQaValidationNode(
  node: Pick<ExecutableNode, 'role' | 'outputs'>,
): boolean {
  return (
    node.role === 'qa' &&
    node.outputs.some((output) =>
      ['test-report', 'ac-evidence'].includes(output.type),
    )
  );
}

export function requiredArtifactTypesForNode(input: {
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

export function assertSuccessfulAgentRun(result: AgentRunResult): void {
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
