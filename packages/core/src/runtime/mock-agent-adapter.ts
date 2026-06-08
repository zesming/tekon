import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ArtifactType } from '../types/domain.js';
import type { AgentAdapter } from './agent-adapter.js';

const builtInArtifactTypes: ArtifactType[] = [
  'demand-card',
  'prd',
  'tech-design',
  'code-changes',
  'test-report',
  'review-report',
  'security-report',
  'rollback-plan',
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
              content: formatMockArtifactContent(type, input.roleConfig.role),
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

function formatMockArtifactContent(type: ArtifactType, role: string): string {
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
