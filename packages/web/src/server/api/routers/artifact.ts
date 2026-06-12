import type { ServerContext } from '../context.js';
import { assertRunInScope, listArtifacts } from '../queries.js';
import { mapArtifact } from '../mappers.js';

export function createArtifactRouter(context: ServerContext) {
  return {
    async list(artifactInput: { runId: string }) {
      assertRunInScope(context.db, context.projectContext, artifactInput.runId);
      return {
        artifacts: listArtifacts(context.db, artifactInput.runId).map(
          mapArtifact,
        ),
      };
    },
  };
}
