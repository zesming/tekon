import { z } from 'zod';

import type { ArtifactType } from '../types/domain.js';

const markdownArtifactPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  summary: z.string().min(1).optional(),
});

export const artifactPayloadSchemas = {
  'demand-card': markdownArtifactPayloadSchema,
  prd: markdownArtifactPayloadSchema,
  'tech-design': markdownArtifactPayloadSchema,
  'code-changes': markdownArtifactPayloadSchema,
  'test-report': markdownArtifactPayloadSchema,
  'review-report': markdownArtifactPayloadSchema,
  'security-report': markdownArtifactPayloadSchema,
  'rollback-plan': markdownArtifactPayloadSchema,
  'delivery-package': markdownArtifactPayloadSchema,
} satisfies Record<ArtifactType, typeof markdownArtifactPayloadSchema>;

export type ArtifactPayload = z.infer<typeof markdownArtifactPayloadSchema>;

export function validateArtifactPayload(
  type: ArtifactType,
  payload: unknown,
): ArtifactPayload {
  return artifactPayloadSchemas[type].parse(payload);
}

export function validateArtifactContent(
  type: ArtifactType,
  content: string,
): ArtifactPayload {
  const trimmed = content.trim();
  const [headingLine, ...bodyLines] = trimmed.split(/\r?\n/u);
  const heading = headingLine?.match(/^#\s+(.+)$/u)?.[1]?.trim();
  const body = bodyLines.join('\n').trim();

  return validateArtifactPayload(type, {
    title: heading ?? '',
    body,
  });
}
