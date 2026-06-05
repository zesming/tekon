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
        for (const type of builtInArtifactTypes) {
          artifacts.push(
            await input.artifactStore.writeArtifact({
              runId: input.runContext.runId,
              nodeId: input.runContext.nodeId,
              type,
              content: `# ${type}\n\nDeterministic mock artifact for ${input.roleConfig.role}.`,
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
