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

const roleSchema = z.enum(['pm', 'rd', 'qa', 'reviewer', 'pmo']);

const reviewScopeSchema = z.enum([
  'demand-quality',
  'requirement-interface',
  'technical-design',
  'implementation-risk',
  'test-plan',
  'test-plan-intent',
  'validation',
  'release-signoff',
  'code-change',
  'process-completeness',
  'delivery-readiness',
]);

const reviewProcessSchema = z.object({
  mode: z.enum(['independent-agent', 'independent-process']),
  reviewerId: z.string().min(1),
  reviewerRole: roleSchema,
  targetNodeId: z.string().min(1),
  targetRole: roleSchema,
});

const reviewFindingSchema = z.object({
  severity: z.enum(['critical', 'important', 'minor']).default('minor'),
  ownerRole: roleSchema.optional(),
  message: z.string().min(1),
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

const requiredEvidenceArtifactPayloadSchema =
  markdownArtifactPayloadSchema.extend({
    criteriaEvidence: z.array(criteriaEvidenceSchema).min(1),
  });

const roleScopedReviewPayloadSchema = evidenceArtifactPayloadSchema.extend({
  reviewScope: reviewScopeSchema,
  reviewProcess: reviewProcessSchema,
  decision: z.enum(['approved', 'changes-requested', 'blocked']),
  findings: z.array(reviewFindingSchema).default([]),
});

const testCaseSchema = z.object({
  id: z.string().min(1),
  criterionId: z.string().min(1).optional(),
  description: z.string().min(1),
  method: z.enum(['unit', 'integration', 'e2e', 'manual', 'static']).optional(),
});

const testPlanPayloadSchema = markdownArtifactPayloadSchema.extend({
  testBasis: z.array(z.string().min(1)).min(1),
  testCases: z.array(testCaseSchema).min(1),
  criteriaEvidence: z.array(criteriaEvidenceSchema).min(1).optional(),
});

const qaReleaseSignoffPayloadSchema =
  requiredEvidenceArtifactPayloadSchema.extend({
    targetRef: z.string().min(1),
    validatedRef: z.string().min(1),
    overallStatus: z.enum(['passed', 'failed', 'blocked']),
  });

const processCheckpointPayloadSchema = evidenceArtifactPayloadSchema.extend({
  requiredNodes: z
    .array(
      z.object({
        nodeId: z.string().min(1),
        status: z.enum(['passed', 'skipped']),
      }),
    )
    .min(1),
  artifactEvidence: z
    .array(
      z.object({
        nodeId: z.string().min(1),
        type: z.string().min(1),
      }),
    )
    .default([]),
  gateEvidence: z
    .array(
      z.object({
        nodeId: z.string().min(1),
        gateType: z.string().min(1),
        gateKey: z.string().min(1),
        status: z.enum(['passed', 'skipped']),
      }),
    )
    .default([]),
  humanDecisionEvidence: z.object({
    pending: z.number().int().min(0),
  }),
  missingInformation: z.array(z.string().min(1)).default([]),
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
  'ac-evidence': requiredEvidenceArtifactPayloadSchema,
  'demand-card': acceptanceArtifactPayloadSchema,
  'demand-review': roleScopedReviewPayloadSchema,
  prd: acceptanceArtifactPayloadSchema,
  'tech-design': markdownArtifactPayloadSchema,
  'implementation-plan': markdownArtifactPayloadSchema,
  'requirement-interface-review': roleScopedReviewPayloadSchema,
  'technical-review': roleScopedReviewPayloadSchema,
  'code-changes': markdownArtifactPayloadSchema,
  'code-review': roleScopedReviewPayloadSchema,
  'test-plan': testPlanPayloadSchema,
  'test-plan-review': roleScopedReviewPayloadSchema,
  'test-report': evidenceArtifactPayloadSchema,
  'qa-release-signoff': qaReleaseSignoffPayloadSchema,
  'qa-release-signoff-review': roleScopedReviewPayloadSchema,
  'review-report': evidenceArtifactPayloadSchema,
  'security-report': securityReportPayloadSchema,
  'rollback-plan': markdownArtifactPayloadSchema,
  'process-checkpoint': processCheckpointPayloadSchema,
  'delivery-package': evidenceArtifactPayloadSchema,
  'ci-status': ciStatusPayloadSchema,
} satisfies Record<ArtifactType, z.ZodTypeAny>;

export type ArtifactPayload = z.infer<typeof markdownArtifactPayloadSchema> & {
  acceptanceCriteria?: z.infer<typeof acceptanceCriterionSchema>[];
  criteriaEvidence?: z.infer<typeof criteriaEvidenceSchema>[];
  reviewScope?: z.infer<typeof reviewScopeSchema>;
  reviewProcess?: z.infer<typeof reviewProcessSchema>;
  decision?: z.infer<typeof roleScopedReviewPayloadSchema>['decision'];
  findings?: z.infer<typeof reviewFindingSchema>[];
  targetRef?: string;
  validatedRef?: string;
  overallStatus?: z.infer<
    typeof qaReleaseSignoffPayloadSchema
  >['overallStatus'];
  requiredNodes?: z.infer<
    typeof processCheckpointPayloadSchema
  >['requiredNodes'];
  artifactEvidence?: z.infer<
    typeof processCheckpointPayloadSchema
  >['artifactEvidence'];
  gateEvidence?: z.infer<typeof processCheckpointPayloadSchema>['gateEvidence'];
  humanDecisionEvidence?: z.infer<
    typeof processCheckpointPayloadSchema
  >['humanDecisionEvidence'];
  missingInformation?: string[];
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
    return validateArtifactPayload(
      type,
      structured.format === 'json'
        ? normalizeStructuredPayload(type, structured.payload)
        : structured.payload,
    );
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

type StructuredPayload = {
  format: 'json' | 'yaml';
  payload: unknown;
};

function parseStructuredPayload(content: string): StructuredPayload | null {
  const trimmed = content.trim();
  if (trimmed.startsWith('{')) {
    try {
      return { format: 'json', payload: JSON.parse(trimmed) };
    } catch {
      // Malformed JSON — fall through to markdown parsing
    }
  }

  if (trimmed.startsWith('---')) {
    try {
      const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(trimmed);
      if (match) {
        return { format: 'yaml', payload: parseYaml(match[1]) };
      }
    } catch {
      // Malformed YAML — fall through to markdown parsing
    }
  }

  return null;
}

function normalizeStructuredPayload(
  type: ArtifactType,
  payload: unknown,
): unknown {
  if (type === 'demand-card' || type === 'prd') {
    return normalizeAcceptanceArtifactPayload(payload);
  }
  if (isRoleScopedReviewArtifact(type)) {
    return normalizeRoleScopedReviewPayload(payload);
  }
  if (type === 'test-plan') {
    return normalizeTestPlanPayload(payload);
  }
  if (type === 'test-report' || type === 'ac-evidence') {
    return normalizeQaEvidencePayload(payload);
  }
  if (type === 'code-changes') {
    return normalizeCodeChangesPayload(payload);
  }
  return payload;
}

function normalizeQaEvidencePayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (typeof record.summary !== 'string') {
    const summary = providerStyleSummary(record.summary);
    if (summary) {
      updates.summary = summary;
    }
  }
  const originalCriteriaEvidence = record.criteriaEvidence;
  if (Array.isArray(originalCriteriaEvidence)) {
    const criteriaEvidence = originalCriteriaEvidence.map((entry) =>
      normalizeProviderStyleCriteriaEvidence(entry),
    );
    if (
      criteriaEvidence.some(
        (entry, index) => entry !== originalCriteriaEvidence[index],
      )
    ) {
      updates.criteriaEvidence = criteriaEvidence;
    }
  }
  if (Object.keys(updates).length === 0) {
    return payload;
  }
  return {
    ...record,
    ...updates,
  };
}

function providerStyleSummary(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const entries = Object.entries(value)
    .map(([key, entry]) => {
      const text = providerStyleSummaryValue(entry);
      return text ? `${key}: ${text}` : undefined;
    })
    .filter((entry): entry is string => entry !== undefined);
  return entries.length > 0 ? entries.join('; ') : undefined;
}

function providerStyleSummaryValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return nonEmptyString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    const values = value
      .map((entry) => providerStyleSummaryValue(entry))
      .filter((entry): entry is string => entry !== undefined);
    return values.length > 0 ? values.join(', ') : undefined;
  }
  if (typeof value === 'object' && value !== null) {
    return JSON.stringify(value);
  }
  return undefined;
}

function normalizeProviderStyleCriteriaEvidence(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) {
    return entry;
  }
  const record = entry as Record<string, unknown>;
  const criterionId =
    nonEmptyString(record.criterionId) ?? nonEmptyString(record.id);
  const status = providerStyleCriteriaEvidenceStatus(record.status);
  const evidenceObject = providerStyleEvidenceObject(record.evidence);
  const evidence =
    evidenceObject?.evidence ??
    nonEmptyString(record.evidence) ??
    nonEmptyString(record.evidenceSummary) ??
    nonEmptyString(record.coverage);
  if (
    criterionId === record.criterionId &&
    status === record.status &&
    evidence === record.evidence
  ) {
    return entry;
  }
  return {
    ...record,
    ...(criterionId ? { criterionId } : {}),
    ...(status ? { status } : {}),
    ...(evidence ? { evidence } : {}),
    ...providerStyleEvidenceAnchors(record, evidenceObject),
  };
}

function providerStyleEvidenceObject(value: unknown):
  | {
      evidence: string;
      artifactIds?: string[];
      gateResultIds?: string[];
      outputPaths?: string[];
    }
  | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const evidence = nonEmptyString(record.summary);
  if (!evidence) {
    return undefined;
  }
  const artifactIds = nonEmptyStringArray(record.artifactIds);
  const gateResultIds = nonEmptyStringArray(record.gateResultIds);
  const outputPaths = nonEmptyStringArray(record.outputPaths);
  return {
    evidence,
    ...(artifactIds ? { artifactIds } : {}),
    ...(gateResultIds ? { gateResultIds } : {}),
    ...(outputPaths ? { outputPaths } : {}),
  };
}

function providerStyleEvidenceAnchors(
  record: Record<string, unknown>,
  evidenceObject:
    | {
        artifactIds?: string[];
        gateResultIds?: string[];
        outputPaths?: string[];
      }
    | undefined,
): {
  artifactIds?: string[];
  gateResultIds?: string[];
  outputPaths?: string[];
} {
  if (!evidenceObject) {
    return {};
  }
  return {
    ...(!isNonEmptyStringArray(record.artifactIds) && evidenceObject.artifactIds
      ? { artifactIds: evidenceObject.artifactIds }
      : {}),
    ...(!isNonEmptyStringArray(record.gateResultIds) &&
    evidenceObject.gateResultIds
      ? { gateResultIds: evidenceObject.gateResultIds }
      : {}),
    ...(!isNonEmptyStringArray(record.outputPaths) && evidenceObject.outputPaths
      ? { outputPaths: evidenceObject.outputPaths }
      : {}),
  };
}

function providerStyleCriteriaEvidenceStatus(
  value: unknown,
): 'passed' | 'failed' | 'blocked' | 'unknown' | undefined {
  const status = nonEmptyString(value)?.toLowerCase();
  if (!status) {
    return undefined;
  }
  if (
    status === 'passed' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'unknown'
  ) {
    return status;
  }
  if (status.startsWith('passed_with_')) {
    return 'passed';
  }
  if (status.startsWith('failed_with_')) {
    return 'failed';
  }
  if (status.startsWith('blocked_with_')) {
    return 'blocked';
  }
  return undefined;
}

function normalizeTestPlanPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  const updates: Record<string, unknown> = {};
  if (!isNonEmptyStringArray(record.testBasis)) {
    const testBasis = providerStyleTestBasis(record);
    if (testBasis.length > 0) {
      updates.testBasis = testBasis;
    }
  }
  if (!Array.isArray(record.testCases) || record.testCases.length === 0) {
    const testCases = providerStyleTestCases(record);
    if (testCases.length > 0) {
      updates.testCases = testCases;
    }
  }
  if (Object.keys(updates).length === 0) {
    return payload;
  }
  return {
    ...record,
    ...updates,
  };
}

function providerStyleTestBasis(record: Record<string, unknown>): string[] {
  if (Array.isArray(record.sourceArtifactsReviewed)) {
    const basis = record.sourceArtifactsReviewed
      .map((entry) => formatTestBasisEntry(entry))
      .filter((entry): entry is string => entry !== undefined);
    if (basis.length > 0) {
      return basis;
    }
  }
  if (Array.isArray(record.acceptanceCoverage)) {
    return record.acceptanceCoverage
      .map((entry) => {
        if (typeof entry !== 'object' || entry === null) {
          return undefined;
        }
        const coverage = entry as Record<string, unknown>;
        const id = nonEmptyString(coverage.id);
        const label = nonEmptyString(coverage.coverage);
        return id && label ? `${id}: ${label}` : id;
      })
      .filter((entry): entry is string => entry !== undefined);
  }
  return [];
}

function formatTestBasisEntry(entry: unknown): string | undefined {
  if (typeof entry === 'string') {
    return nonEmptyString(entry);
  }
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const alias = nonEmptyString(record.alias);
  const path = nonEmptyString(record.path);
  if (alias && path) {
    return `${alias}: ${path}`;
  }
  return alias ?? path;
}

function providerStyleTestCases(record: Record<string, unknown>): {
  id: string;
  criterionId?: string;
  description: string;
  method?: 'unit' | 'integration' | 'e2e' | 'manual' | 'static';
}[] {
  if (Array.isArray(record.testScenarios)) {
    const testCases = record.testScenarios
      .map((entry, index) => formatProviderStyleTestCase(entry, index))
      .filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined,
      );
    if (testCases.length > 0) {
      return testCases;
    }
  }
  if (Array.isArray(record.acceptanceCoverage)) {
    return record.acceptanceCoverage
      .map((entry, index) => formatAcceptanceCoverageTestCase(entry, index))
      .filter(
        (entry): entry is NonNullable<typeof entry> => entry !== undefined,
      );
  }
  return [];
}

function formatProviderStyleTestCase(
  entry: unknown,
  index: number,
):
  | {
      id: string;
      criterionId?: string;
      description: string;
      method?: 'unit' | 'integration' | 'e2e' | 'manual' | 'static';
    }
  | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const description =
    nonEmptyString(record.description) ?? nonEmptyString(record.name);
  if (!description) {
    return undefined;
  }
  const id = nonEmptyString(record.id) ?? `TC-${index + 1}`;
  const criterionId = providerStyleCriterionId(record);
  const method = providerStyleTestMethod(record.type);
  return {
    id,
    ...(criterionId ? { criterionId } : {}),
    description,
    ...(method ? { method } : {}),
  };
}

function formatAcceptanceCoverageTestCase(
  entry: unknown,
  index: number,
):
  | {
      id: string;
      criterionId?: string;
      description: string;
      method?: 'unit' | 'integration' | 'e2e' | 'manual' | 'static';
    }
  | undefined {
  if (typeof entry !== 'object' || entry === null) {
    return undefined;
  }
  const record = entry as Record<string, unknown>;
  const criterionId = nonEmptyString(record.id);
  const coverage = nonEmptyString(record.coverage);
  const description =
    nonEmptyString(record.description) ??
    (criterionId && coverage
      ? `Verify ${criterionId}: ${coverage}`
      : criterionId
        ? `Verify ${criterionId}`
        : undefined);
  if (!description) {
    return undefined;
  }
  return {
    id: `TC-${index + 1}`,
    ...(criterionId ? { criterionId } : {}),
    description,
    method: 'manual',
  };
}

function providerStyleCriterionId(
  record: Record<string, unknown>,
): string | undefined {
  const direct = nonEmptyString(record.criterionId);
  if (direct) {
    return direct;
  }
  const mapsTo = record.mapsTo;
  if (Array.isArray(mapsTo)) {
    return mapsTo.map((entry) => nonEmptyString(entry)).find(Boolean);
  }
  return undefined;
}

function providerStyleTestMethod(
  value: unknown,
): 'unit' | 'integration' | 'e2e' | 'manual' | 'static' | undefined {
  const type = nonEmptyString(value)?.toLowerCase();
  if (!type) {
    return undefined;
  }
  if (type.includes('unit')) {
    return 'unit';
  }
  if (type.includes('integration') || type.includes('component')) {
    return 'integration';
  }
  if (type.includes('e2e')) {
    return 'e2e';
  }
  if (type.includes('static') || type.includes('diff')) {
    return 'static';
  }
  return 'manual';
}

function isNonEmptyStringArray(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => nonEmptyString(entry))
  );
}

function nonEmptyStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((entry) => nonEmptyString(entry))
    .filter((entry): entry is string => entry !== undefined);
  return items.length > 0 ? items : undefined;
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

function normalizeRoleScopedReviewPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  if (!Array.isArray(record.findings)) {
    return payload;
  }
  const originalFindings = record.findings;

  const findings = originalFindings.map((entry) =>
    normalizeReviewFinding(entry),
  );
  if (findings.every((entry, index) => entry === originalFindings[index])) {
    return payload;
  }

  return {
    ...record,
    findings,
  };
}

function normalizeReviewFinding(entry: unknown): unknown {
  if (typeof entry !== 'object' || entry === null) {
    return entry;
  }
  const record = entry as Record<string, unknown>;
  const ownerRole = nonEmptyString(record.ownerRole);
  if (!ownerRole || isRole(ownerRole)) {
    return entry;
  }
  const message = nonEmptyString(record.message);
  if (!message) {
    return entry;
  }
  const { ownerRole: _ownerRole, ...rest } = record;
  return {
    ...rest,
    message: `[ownerRole: ${ownerRole}] ${message}`,
  };
}

function isRole(value: string): value is z.infer<typeof roleSchema> {
  return ['pm', 'rd', 'qa', 'reviewer', 'pmo'].includes(value);
}

function normalizeCodeChangesPayload(payload: unknown): unknown {
  if (
    typeof payload !== 'object' ||
    payload === null ||
    'title' in payload ||
    'body' in payload
  ) {
    return payload;
  }
  const record = payload as Record<string, unknown>;
  const summary = nonEmptyString(record.summary);
  const body = providerStyleBody(record);
  if (!summary && !body) {
    return payload;
  }

  return {
    ...record,
    title: 'Code changes',
    body: body || summary,
    summary: summary ?? 'Code changes',
  };
}

function normalizeAcceptanceArtifactPayload(payload: unknown): unknown {
  if (typeof payload !== 'object' || payload === null) {
    return payload;
  }

  const record = payload as Record<string, unknown>;
  const criteria =
    normalizeProviderStyleAcceptanceCriteria(record.acceptanceCriteria) ??
    normalizeProviderStyleAcceptanceCriteria(record.acceptance_criteria);
  if (!criteria) {
    return payload;
  }

  return {
    ...record,
    acceptanceCriteria: criteria,
  };
}

function normalizeProviderStyleAcceptanceCriteria(value: unknown):
  | {
      id: string;
      description: string;
      verification?: string;
    }[]
  | undefined {
  if (!Array.isArray(value) || value.length === 0) {
    return undefined;
  }

  const criteria: {
    id: string;
    description: string;
    verification?: string;
  }[] = [];
  for (const entry of value) {
    if (typeof entry !== 'object' || entry === null) {
      return undefined;
    }
    const record = entry as Record<string, unknown>;
    const id = nonEmptyString(record.id);
    const description =
      nonEmptyString(record.description) ?? nonEmptyString(record.criterion);
    if (!id || !description) {
      return undefined;
    }
    const verification = nonEmptyString(record.verification);
    criteria.push({
      id,
      description,
      ...(verification ? { verification } : {}),
    });
  }

  return criteria;
}

function providerStyleBody(record: Record<string, unknown>): string {
  const sections: string[] = [];
  if (Array.isArray(record.changedFiles)) {
    const changedFiles = record.changedFiles
      .map((entry) => formatChangedFile(entry))
      .filter((entry) => entry.length > 0);
    if (changedFiles.length > 0) {
      sections.push(['Changed files:', ...changedFiles].join('\n'));
    }
  }
  if (Array.isArray(record.verification)) {
    const verification = record.verification
      .map((entry) => formatCommandEvidence(entry))
      .filter((entry) => entry.length > 0);
    if (verification.length > 0) {
      sections.push(['Verification:', ...verification].join('\n'));
    }
  }
  return sections.join('\n\n');
}

function formatChangedFile(entry: unknown): string {
  if (typeof entry === 'string') {
    const value = entry.trim();
    return value ? `- ${value}` : '';
  }
  if (typeof entry !== 'object' || entry === null) {
    return '';
  }
  const record = entry as Record<string, unknown>;
  const path = nonEmptyString(record.path);
  const changes = Array.isArray(record.changes)
    ? record.changes
        .map((change) => nonEmptyString(change))
        .filter((change): change is string => change !== undefined)
    : [];
  if (!path && changes.length === 0) {
    return '';
  }
  return [
    path ? `- ${path}` : '- changed file',
    ...changes.map((change) => `  - ${change}`),
  ].join('\n');
}

function formatCommandEvidence(entry: unknown): string {
  if (typeof entry === 'string') {
    const value = entry.trim();
    return value ? `- ${value}` : '';
  }
  if (typeof entry !== 'object' || entry === null) {
    return '';
  }
  const record = entry as Record<string, unknown>;
  const command = nonEmptyString(record.command);
  const result = nonEmptyString(record.result);
  if (!command && !result) {
    return '';
  }
  return [`- ${command ?? 'command'}`, result ? `  - ${result}` : undefined]
    .filter((line): line is string => line !== undefined)
    .join('\n');
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : undefined;
}
