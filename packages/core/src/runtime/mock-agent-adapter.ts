import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ArtifactType, Role } from '../types/domain.js';
import type { AgentAdapter, AgentRunInput } from './agent-adapter.js';

const builtInArtifactTypes: ArtifactType[] = [
  'ac-evidence',
  'demand-card',
  'demand-review',
  'prd',
  'tech-design',
  'implementation-plan',
  'requirement-interface-review',
  'technical-review',
  'code-changes',
  'code-review',
  'test-plan',
  'test-plan-review',
  'test-report',
  'qa-release-signoff',
  'qa-release-signoff-review',
  'review-report',
  'security-report',
  'rollback-plan',
  'process-checkpoint',
  'delivery-package',
];

export function createMockAgentAdapter(): AgentAdapter {
  return {
    async runAgent(input) {
      const startedAt = Date.now();
      mkdirSync(input.outputDir, { recursive: true });
      const transcriptPath = join(input.outputDir, 'mock-agent-transcript.txt');
      writeFileSync(
        transcriptPath,
        `role=${input.roleConfig.role}\nprompt=${input.prompt}\n`,
        'utf8',
      );

      const artifacts = [];
      if (input.artifactStore) {
        const artifactTypes =
          input.requiredArtifactTypes && input.requiredArtifactTypes.length > 0
            ? input.requiredArtifactTypes
            : builtInArtifactTypes;
        for (const type of artifactTypes) {
          artifacts.push(
            await input.artifactStore.writeArtifact({
              runId: input.runContext.runId,
              nodeId: input.runContext.nodeId,
              type,
              content: formatMockArtifactContent(type, input, transcriptPath),
            }),
          );
        }
      }

      return {
        provider: 'mock',
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        outputFiles: artifacts.map((artifact) => artifact.path),
        artifacts,
        timedOut: false,
      };
    },
  };
}

function formatMockArtifactContent(
  type: ArtifactType,
  input: AgentRunInput,
  transcriptPath: string,
): string {
  const role = input.roleConfig.role;
  const base = {
    title: type,
    body: `Deterministic mock artifact for ${role}.`,
  };
  if (type === 'demand-card' || type === 'prd') {
    return JSON.stringify(
      {
        ...base,
        acceptanceCriteria: [
          {
            id: 'AC-1',
            description: 'The requested workflow evidence is present.',
            verification: 'Review delivery package and gate results.',
          },
        ],
      },
      null,
      2,
    );
  }
  if (
    type === 'ac-evidence' ||
    type === 'test-report' ||
    type === 'review-report' ||
    type === 'delivery-package'
  ) {
    return JSON.stringify(
      {
        ...base,
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: `Mock ${type} verifies AC-1.`,
            outputPaths: [transcriptPath],
          },
        ],
      },
      null,
      2,
    );
  }
  if (isRoleScopedReviewArtifact(type)) {
    const target = reviewTargetForMock(type, input);
    return JSON.stringify(
      {
        ...base,
        reviewScope: reviewScopeForMock(type, role),
        reviewProcess: {
          mode: 'independent-process',
          reviewerId: `mock-${role}-${type}`,
          reviewerRole: role,
          targetNodeId: target.nodeId,
          targetRole: target.role,
        },
        decision: 'approved',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: `Mock ${type} review covers AC-1.`,
            outputPaths: [transcriptPath],
          },
        ],
      },
      null,
      2,
    );
  }
  if (type === 'test-plan') {
    return JSON.stringify(
      {
        ...base,
        testBasis: ['demand-card', 'prd'],
        testCases: [
          {
            id: 'TC-1',
            criterionId: 'AC-1',
            description: 'Verify AC-1.',
            method: 'unit',
          },
        ],
      },
      null,
      2,
    );
  }
  if (type === 'qa-release-signoff') {
    const deliveryRef = input.deliveryRef ?? 'mock-ref';
    return JSON.stringify(
      {
        ...base,
        targetRef: deliveryRef,
        validatedRef: deliveryRef,
        overallStatus: 'passed',
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: `Mock QA signoff validates ${deliveryRef}.`,
            outputPaths: [transcriptPath],
          },
        ],
        coveredCriteriaIds: ['AC-1'],
      },
      null,
      2,
    );
  }
  if (type === 'process-checkpoint') {
    return JSON.stringify(
      {
        ...base,
        requiredNodes: processRequiredNodesForMock(input),
        artifactEvidence: processArtifactEvidenceForMock(input),
        gateEvidence: processGateEvidenceForMock(input),
        humanDecisionEvidence: { pending: 0 },
        missingInformation: [],
        criteriaEvidence: [
          {
            criterionId: 'AC-1',
            status: 'passed',
            evidence: 'Mock process checkpoint covers AC-1.',
            outputPaths: [transcriptPath],
          },
        ],
      },
      null,
      2,
    );
  }
  if (type === 'security-report') {
    return JSON.stringify({ ...base, securityFindings: [] }, null, 2);
  }
  return `# ${type}\n\n${base.body}`;
}

function isRoleScopedReviewArtifact(type: ArtifactType): boolean {
  return [
    'code-review',
    'demand-review',
    'qa-release-signoff-review',
    'requirement-interface-review',
    'technical-review',
    'test-plan-review',
  ].includes(type);
}

function reviewScopeForMock(type: ArtifactType, role: string): string {
  if (type === 'demand-review') {
    return 'demand-quality';
  }
  if (type === 'requirement-interface-review') {
    return 'requirement-interface';
  }
  if (type === 'technical-review') {
    return 'technical-design';
  }
  if (type === 'test-plan-review') {
    return role === 'pm' ? 'test-plan-intent' : 'test-plan';
  }
  if (type === 'qa-release-signoff-review') {
    return 'release-signoff';
  }
  if (type === 'code-review') {
    return 'code-change';
  }
  return 'delivery-readiness';
}

function reviewTargetForMock(
  type: ArtifactType,
  input: AgentRunInput,
): { nodeId: string; role: Role } {
  const preferredArtifactTypes = preferredReviewTargetTypes(type);
  const inputs = input.nodeInputs ?? [];
  const targetInput =
    preferredArtifactTypes
      .map((artifactType) =>
        inputs.find((candidate) => candidate.type === artifactType),
      )
      .find(Boolean) ?? inputs[0];
  const targetNodeId =
    targetInput?.fromNodeId ??
    input.nodeDependencies?.[0] ??
    input.runContext.nodeId;
  const targetRole =
    input.priorNodes?.find((node) => node.id === targetNodeId)?.role ??
    fallbackTargetRoleForMock(type);

  return { nodeId: targetNodeId, role: targetRole };
}

function preferredReviewTargetTypes(type: ArtifactType): ArtifactType[] {
  if (type === 'code-review') {
    return ['code-changes'];
  }
  if (type === 'demand-review') {
    return ['prd', 'demand-card'];
  }
  if (type === 'qa-release-signoff-review') {
    return ['qa-release-signoff'];
  }
  if (type === 'requirement-interface-review') {
    return ['prd', 'demand-card', 'demand-review'];
  }
  if (type === 'technical-review') {
    return ['implementation-plan'];
  }
  if (type === 'test-plan-review') {
    return ['test-plan'];
  }
  return [];
}

function fallbackTargetRoleForMock(type: ArtifactType): Role {
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

function processRequiredNodesForMock(input: AgentRunInput) {
  return (input.priorNodes ?? [])
    .filter((node) => node.status === 'passed' || node.status === 'skipped')
    .map((node) => ({
      nodeId: node.id,
      status: node.status,
    }));
}

function processArtifactEvidenceForMock(input: AgentRunInput) {
  return (input.priorNodes ?? []).flatMap((node) =>
    (node.outputs ?? []).map((output) => ({
      nodeId: node.id,
      type: output.type,
    })),
  );
}

function processGateEvidenceForMock(input: AgentRunInput) {
  return (input.priorNodes ?? []).flatMap((node) =>
    (node.gates ?? []).map((gate) => ({
      nodeId: node.id,
      gateType: gate.type,
      gateKey: gate.gateKey,
      status: node.status === 'skipped' ? 'skipped' : 'passed',
    })),
  );
}
