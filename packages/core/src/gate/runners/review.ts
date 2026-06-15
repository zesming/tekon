import { writeFileSync } from 'node:fs';

import type { ArtifactType, Node, Role } from '../../types/domain.js';
import type { TekonRepositories } from '../../db/repositories.js';
import type { CommandGateway } from '../../runtime/command-gateway.js';
import {
  type GateRunnerInput,
  makeGateResult,
  semanticGateOutputPath,
  latestArtifactPayload,
} from '../helpers.js';
import type { GateDefinition } from '../registry.js';

// ---------------------------------------------------------------------------
// Role-scope permission tables
// ---------------------------------------------------------------------------

const allowedReviewScopesByRole: Record<Role, string[]> = {
  pm: ['demand-quality', 'test-plan-intent'],
  rd: ['requirement-interface', 'technical-design', 'implementation-risk'],
  qa: ['requirement-interface', 'test-plan', 'validation', 'release-signoff'],
  reviewer: ['code-change'],
  pmo: ['process-completeness', 'delivery-readiness'],
};

const allowedReviewScopesByArtifact: Partial<Record<ArtifactType, string[]>> =
  {
    'code-review': ['code-change'],
    'demand-review': ['demand-quality'],
    'qa-release-signoff-review': ['release-signoff'],
    'requirement-interface-review': ['requirement-interface'],
    'technical-review': ['technical-design', 'implementation-risk'],
    'test-plan-review': ['test-plan', 'test-plan-intent'],
  };

const expectedReviewTargetTypesByArtifact: Partial<
  Record<ArtifactType, ArtifactType[]>
> = {
  'code-review': ['code-changes'],
  'demand-review': ['demand-card', 'prd', 'demand-review'],
  'qa-release-signoff-review': ['qa-release-signoff'],
  'requirement-interface-review': ['demand-card', 'prd', 'demand-review'],
  'technical-review': ['implementation-plan'],
  'test-plan-review': ['test-plan'],
};

// ---------------------------------------------------------------------------
// Gate definitions
// ---------------------------------------------------------------------------

export function reviewGateDefinitions(deps: {
  repositories: TekonRepositories;
  gateway?: CommandGateway;
}): GateDefinition[] {
  return [
    {
      type: 'independent-review',
      category: 'review',
      tags: ['review', 'governance'],
      metadata: {
        commandLike: false,
        humanBlocking: false,
        supportsNotApplicable: false,
        requiredEvidence: ['code-review', 'demand-review'],
        sideEffect: 'none',
        riskTags: ['quality', 'governance'],
      },
      runner: async (input: GateRunnerInput) =>
        runIndependentReviewGate(input, deps.repositories),
    },
    {
      type: 'role-scope',
      category: 'review',
      tags: ['review', 'governance', 'permission'],
      metadata: {
        commandLike: false,
        humanBlocking: false,
        supportsNotApplicable: false,
        requiredEvidence: ['code-review', 'demand-review'],
        sideEffect: 'none',
        riskTags: ['quality', 'governance'],
      },
      runner: async (input: GateRunnerInput) =>
        runRoleScopeGate(input, deps.repositories),
    },
  ];
}

// ---------------------------------------------------------------------------
// Independent review runner
// ---------------------------------------------------------------------------

async function runIndependentReviewGate(
  input: GateRunnerInput,
  repositories: TekonRepositories,
): Promise<ReturnType<typeof makeGateResult>> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, outputPath);
  if ('result' in loaded) {
    return loaded.result;
  }

  const process = loaded.payload.reviewProcess;
  if (!process) {
    writeFileSync(outputPath, 'missing reviewProcess', 'utf8');
    return makeGateResult(
      input,
      'failed',
      'missing-review-process',
      outputPath,
    );
  }
  if (process.targetNodeId === input.nodeId) {
    writeFileSync(
      outputPath,
      `self review is not independent: ${process.targetNodeId}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'self-review', outputPath);
  }
  const currentNode = await repositories.getNode(input.nodeId);
  if (!currentNode) {
    writeFileSync(outputPath, `node not found: ${input.nodeId}`, 'utf8');
    return makeGateResult(input, 'failed', 'missing-node', outputPath);
  }
  const reviewerRoleRun = await repositories.getLatestRoleRunForNode(
    input.runId,
    input.nodeId,
  );
  if (
    !reviewerRoleRun ||
    reviewerRoleRun.role !== currentNode.role ||
    reviewerRoleRun.status !== 'passed' ||
    !reviewerRoleRun.completedAt
  ) {
    writeFileSync(
      outputPath,
      `missing completed reviewer role run for ${input.nodeId}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'missing-reviewer-role-run',
      outputPath,
    );
  }
  const targetNode = await repositories.getNode(process.targetNodeId);
  if (!targetNode || targetNode.runId !== input.runId) {
    writeFileSync(
      outputPath,
      `review target node not found: ${process.targetNodeId}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'missing-review-target', outputPath);
  }
  if (process.targetRole !== targetNode.role) {
    writeFileSync(
      outputPath,
      `targetRole ${process.targetRole} does not match target node role ${targetNode.role}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'target-role-mismatch', outputPath);
  }
  if (process.reviewerRole !== currentNode.role) {
    writeFileSync(
      outputPath,
      `reviewerRole ${process.reviewerRole} does not match node role ${currentNode.role}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'role-mismatch', outputPath);
  }
  if (!isReviewTargetConnected(currentNode, targetNode.id)) {
    writeFileSync(
      outputPath,
      `review target ${targetNode.id} is not an upstream input or dependency of ${currentNode.id}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'review-target-out-of-flow',
      outputPath,
    );
  }
  const expectedTargetTypes =
    expectedReviewTargetTypesByArtifact[loaded.artifact.type as ArtifactType];
  if (
    expectedTargetTypes &&
    !targetNode.outputs.some((output) =>
      expectedTargetTypes.includes(output.type),
    )
  ) {
    writeFileSync(
      outputPath,
      `${loaded.artifact.type} target ${targetNode.id} must produce one of: ${expectedTargetTypes.join(', ')}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'review-target-artifact-mismatch',
      outputPath,
    );
  }
  if (loaded.payload.decision && loaded.payload.decision !== 'approved') {
    writeFileSync(
      outputPath,
      `review decision is ${loaded.payload.decision}`,
      'utf8',
    );
    const classification =
      loaded.payload.decision === 'changes-requested'
        ? 'changes-requested'
        : 'review-not-approved';
    return makeGateResult(input, 'failed', classification, outputPath);
  }

  writeFileSync(
    outputPath,
    `independent review passed for ${loaded.artifact.type}: ${loaded.artifact.path}`,
    'utf8',
  );
  return makeGateResult(input, 'passed', null, outputPath);
}

// ---------------------------------------------------------------------------
// Role-scope runner
// ---------------------------------------------------------------------------

async function runRoleScopeGate(
  input: GateRunnerInput,
  repositories: TekonRepositories,
): Promise<ReturnType<typeof makeGateResult>> {
  const outputPath = semanticGateOutputPath(input);
  const loaded = await latestArtifactPayload(input, outputPath);
  if ('result' in loaded) {
    return loaded.result;
  }
  const node = await repositories.getNode(input.nodeId);
  if (!node) {
    writeFileSync(outputPath, `node not found: ${input.nodeId}`, 'utf8');
    return makeGateResult(input, 'failed', 'missing-node', outputPath);
  }
  const reviewScope = loaded.payload.reviewScope;
  if (!reviewScope) {
    writeFileSync(outputPath, 'missing reviewScope', 'utf8');
    return makeGateResult(input, 'failed', 'missing-review-scope', outputPath);
  }
  const allowed = allowedReviewScopesByRole[node.role];
  if (!allowed.includes(reviewScope)) {
    writeFileSync(
      outputPath,
      `${reviewScope} is not allowed for ${node.role}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'role-scope-violation', outputPath);
  }
  const allowedForArtifact =
    allowedReviewScopesByArtifact[loaded.artifact.type as ArtifactType];
  if (allowedForArtifact && !allowedForArtifact.includes(reviewScope)) {
    writeFileSync(
      outputPath,
      `${reviewScope} is not allowed for ${loaded.artifact.type}`,
      'utf8',
    );
    return makeGateResult(
      input,
      'failed',
      'artifact-scope-violation',
      outputPath,
    );
  }
  if (
    loaded.payload.reviewProcess &&
    loaded.payload.reviewProcess.reviewerRole !== node.role
  ) {
    writeFileSync(
      outputPath,
      `reviewerRole ${loaded.payload.reviewProcess.reviewerRole} does not match node role ${node.role}`,
      'utf8',
    );
    return makeGateResult(input, 'failed', 'role-mismatch', outputPath);
  }

  writeFileSync(
    outputPath,
    `role scope passed for ${node.role}: ${reviewScope}`,
    'utf8',
  );
  return makeGateResult(input, 'passed', null, outputPath);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isReviewTargetConnected(node: Node, targetNodeId: string): boolean {
  return (
    node.inputs.some((input) => input.fromNodeId === targetNodeId) ||
    node.dependencies.includes(targetNodeId)
  );
}
