import { z } from 'zod';
import { parse as parseYaml } from 'yaml';

import type { ArtifactType } from '../types/domain.js';

const acceptanceCriterionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  verification: z.string().min(1).optional(),
});

const criteriaEvidenceSchema = z.object({
  criterionId: z.string().min(1),
  status: z.enum(['passed', 'failed', 'blocked', 'unknown']),
  evidence: z.string().min(1),
  artifactIds: z.array(z.string().min(1)).default([]),
  gateResultIds: z.array(z.string().min(1)).default([]),
  outputPaths: z.array(z.string().min(1)).default([]),
});

const securityFindingSchema = z.object({
  id: z.string().min(1),
  severity: z.enum(['low', 'medium', 'high', 'critical']),
  path: z.string().min(1).optional(),
  ruleId: z.string().min(1),
  message: z.string().min(1),
});

const markdownArtifactPayloadSchema = z.object({
  title: z.string().min(1),
  body: z.string().min(1),
  summary: z.string().min(1).optional(),
});

const acceptanceArtifactPayloadSchema = markdownArtifactPayloadSchema.extend({
  acceptanceCriteria: z.array(acceptanceCriterionSchema).min(1),
});

const evidenceArtifactPayloadSchema = markdownArtifactPayloadSchema.extend({
  criteriaEvidence: z.array(criteriaEvidenceSchema).min(1).optional(),
});

const securityReportPayloadSchema = markdownArtifactPayloadSchema.extend({
  securityFindings: z.array(securityFindingSchema).default([]),
});

const ciCheckSchema = z.object({
  name: z.string().min(1),
  state: z.string().min(1).optional(),
  bucket: z.string().min(1).optional(),
  workflow: z.string().min(1).optional(),
  link: z.string().url().optional(),
  description: z.string().min(1).optional(),
});

const ciStatusPayloadSchema = markdownArtifactPayloadSchema.extend({
  ciStatus: z.enum(['passed', 'failed', 'pending', 'skipped', 'unknown']),
  prUrl: z.string().url().optional(),
  checkedAt: z.string().datetime(),
  checks: z.array(ciCheckSchema).default([]),
});

export const artifactPayloadSchemas = {
  'demand-card': acceptanceArtifactPayloadSchema,
  prd: acceptanceArtifactPayloadSchema,
  'tech-design': markdownArtifactPayloadSchema,
  'code-changes': markdownArtifactPayloadSchema,
  'test-report': evidenceArtifactPayloadSchema,
  'review-report': evidenceArtifactPayloadSchema,
  'security-report': securityReportPayloadSchema,
  'rollback-plan': markdownArtifactPayloadSchema,
  'delivery-package': evidenceArtifactPayloadSchema,
  'ci-status': ciStatusPayloadSchema,
} satisfies Record<ArtifactType, z.ZodTypeAny>;

export type ArtifactPayload = z.infer<typeof markdownArtifactPayloadSchema> & {
  acceptanceCriteria?: z.infer<typeof acceptanceCriterionSchema>[];
  criteriaEvidence?: z.infer<typeof criteriaEvidenceSchema>[];
  securityFindings?: z.infer<typeof securityFindingSchema>[];
  ciStatus?: z.infer<typeof ciStatusPayloadSchema>['ciStatus'];
  prUrl?: string;
  checkedAt?: string;
  checks?: z.infer<typeof ciCheckSchema>[];
};

export const agentArtifactManifestSchema = z
  .object({
    artifacts: z
      .array(
        z
          .object({
            type: z.enum([
              'demand-card',
              'prd',
              'tech-design',
              'code-changes',
              'test-report',
              'review-report',
              'security-report',
              'rollback-plan',
              'delivery-package',
            ]),
            path: z.string().min(1),
            summary: z.string().min(1).optional(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();
export type AgentArtifactManifest = z.infer<typeof agentArtifactManifestSchema>;

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
  const structured = parseStructuredPayload(content);
  if (structured) {
    return validateArtifactPayload(type, structured);
  }

  const trimmed = content.trim();
  const [headingLine, ...bodyLines] = trimmed.split(/\r?\n/u);
  const heading = headingLine?.match(/^#\s+(.+)$/u)?.[1]?.trim();
  const body = bodyLines.join('\n').trim();

  return validateArtifactPayload(type, {
    title: heading ?? '',
    body,
  });
}

function parseStructuredPayload(content: string): unknown | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    return JSON.parse(trimmed);
  }

  if (trimmed.startsWith('---')) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(trimmed);
    if (match) {
      return parseYaml(match[1]);
    }
  }

  return null;
}
