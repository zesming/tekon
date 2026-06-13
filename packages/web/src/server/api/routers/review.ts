import type { ServerContext } from '../context.js';
import { createWorkReviewSurface, type WorkReviewSurface } from '@tekon/core';
import { assertRunInScope } from '../queries.js';
import { redactObject, redactTextPreview } from '../redaction.js';

export function createReviewRouter(context: ServerContext) {
  return {
    async get(reviewInput: { runId: string; maxContentChars?: number }) {
      assertRunInScope(context.db, context.projectContext, reviewInput.runId);
      const surface = await createWorkReviewSurface({
        repoPath: context.projectContext.projectRoot,
        repositories: context.repositories,
        audit: context.audit,
        runId: reviewInput.runId,
        maxContentChars: reviewInput.maxContentChars,
        commandDisplay: 'explicit',
      });
      return redactReviewSurface(surface);
    },
  };
}

function redactReviewSurface(surface: WorkReviewSurface): WorkReviewSurface {
  const result: WorkReviewSurface = { ...surface };
  // Truncate large content fields first, then redact patterns within them
  if (result.demand && typeof result.demand.body === 'string') {
    result.demand = { ...result.demand, body: redactTextPreview(result.demand.body) };
  }
  if (Array.isArray(result.artifacts)) {
    result.artifacts = result.artifacts.map((artifact) => {
      if (artifact.content && typeof artifact.content.content === 'string') {
        return { ...artifact, content: { ...artifact.content, content: redactTextPreview(artifact.content.content) } };
      }
      return artifact;
    });
  }
  if (Array.isArray(result.gates)) {
    result.gates = result.gates.map((gate) => {
      if (gate.output && typeof gate.output.content === 'string') {
        return { ...gate, output: { ...gate.output, content: redactTextPreview(gate.output.content) } };
      }
      return gate;
    });
  }
  if (result.delivery) {
    const delivery = result.delivery;
    result.delivery = {
      ...delivery,
      package: delivery.package && typeof delivery.package.content === 'string'
        ? { ...delivery.package, content: redactTextPreview(delivery.package.content) }
        : delivery.package,
      prBody: delivery.prBody && typeof delivery.prBody.content === 'string'
        ? { ...delivery.prBody, content: redactTextPreview(delivery.prBody.content) }
        : delivery.prBody,
    };
  }
  // Apply redactObject to catch secrets in ALL remaining string fields
  // (e.g. nextCommands, suggestedCommand, gate triage, evidence text)
  return redactObject(result) as WorkReviewSurface;
}


