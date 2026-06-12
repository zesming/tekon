import type { z } from 'zod';

import {
  apiArtifactSchema,
  apiAuditEventSchema,
  apiGateSchema,
  apiHumanDecisionContextGateSchema,
  apiHumanDecisionContextSchema,
  apiHumanDecisionSchema,
  apiProjectSchema,
  apiWorkflowSchema,
  approvalSummaryCheckSchema,
  approvalSummaryEvaluationSchema,
  auditListInputSchema,
  auditListOutputSchema,
  auditVerificationSchema,
  decisionInputSchema,
  decisionOutputSchema,
  deliveryCiCheckSchema,
  deliveryCiStatusInputSchema,
  deliveryCiStatusOutputSchema,
  deliveryCreatePrInputSchema,
  deliveryCreatePrOutputSchema,
  deliveryDryRunOutputSchema,
  deliveryPrepareOutputSchema,
  demandApproveInputSchema,
  demandApproveOutputSchema,
  demandShapeInputSchema,
  demandShapeOutputSchema,
  artifactListOutputSchema,
  gateListOutputSchema,
  humanApprovalSummarySchema,
  prePullRequestReadinessCheckSchema,
  prePullRequestReadinessSchema,
  progressFileSchema,
  progressListInputSchema,
  progressListOutputSchema,
  projectCleanOutputSchema,
  projectDetailInputSchema,
  projectDetailOutputSchema,
  projectOverviewCountsSchema,
  projectOverviewOutputSchema,
  projectRunInputSchema,
  reviewArtifactSchema,
  reviewDeliverySurfaceSchema,
  reviewDiffSummarySchema,
  reviewEvidenceGroupSchema,
  reviewEvidenceLinkSchema,
  reviewGateFailureTriageSchema,
  reviewGateSchema,
  reviewGetInputSchema,
  roleItemSchema,
  roleListOutputSchema,
  runWrapperOutputSchema,
  textPreviewSchema,
  tokenRunInputSchema,
  workReadinessCheckSchema,
  workReadinessEvaluationSchema,
  workReviewSurfaceSchema,
  workflowItemSchema,
  workflowListOutputSchema,
} from './rpc-contract.js';

// ---------------------------------------------------------------------------
// Core entity types
// ---------------------------------------------------------------------------

export type ApiProject = z.infer<typeof apiProjectSchema>;
export type ApiWorkflow = z.infer<typeof apiWorkflowSchema>;
export type ApiArtifact = z.infer<typeof apiArtifactSchema>;
export type ApiGate = z.infer<typeof apiGateSchema>;
export type ApiAuditEvent = z.infer<typeof apiAuditEventSchema>;
export type ApiHumanDecision = z.infer<typeof apiHumanDecisionSchema>;
export type ApiHumanDecisionContext = z.infer<
  typeof apiHumanDecisionContextSchema
>;
export type ApiHumanDecisionContextGate = z.infer<
  typeof apiHumanDecisionContextGateSchema
>;

// ---------------------------------------------------------------------------
// Approval sub-types
// ---------------------------------------------------------------------------

export type ApiHumanApprovalSummary = z.infer<
  typeof humanApprovalSummarySchema
>;
export type ApiApprovalSummaryEvaluation = z.infer<
  typeof approvalSummaryEvaluationSchema
>;
export type ApiApprovalSummaryCheck = z.infer<
  typeof approvalSummaryCheckSchema
>;

// ---------------------------------------------------------------------------
// Review surface sub-types
// ---------------------------------------------------------------------------

export type ApiTextPreview = z.infer<typeof textPreviewSchema>;
export type ApiWorkReadinessCheck = z.infer<typeof workReadinessCheckSchema>;
export type ApiWorkReadinessEvaluation = z.infer<
  typeof workReadinessEvaluationSchema
>;
export type ApiPrePullRequestReadinessCheck = z.infer<
  typeof prePullRequestReadinessCheckSchema
>;
export type ApiPrePullRequestReadiness = z.infer<
  typeof prePullRequestReadinessSchema
>;
export type ApiReviewArtifact = z.infer<typeof reviewArtifactSchema>;
export type ApiReviewGate = z.infer<typeof reviewGateSchema>;
export type ApiReviewGateFailureTriage = z.infer<
  typeof reviewGateFailureTriageSchema
>;
export type ApiReviewDiffSummary = z.infer<typeof reviewDiffSummarySchema>;
export type ApiReviewDeliverySurface = z.infer<
  typeof reviewDeliverySurfaceSchema
>;
export type ApiReviewEvidenceLink = z.infer<typeof reviewEvidenceLinkSchema>;
export type ApiReviewEvidenceGroup = z.infer<typeof reviewEvidenceGroupSchema>;
export type ApiWorkReviewSurface = z.infer<typeof workReviewSurfaceSchema>;

// ---------------------------------------------------------------------------
// List item types
// ---------------------------------------------------------------------------

export type ApiRoleItem = z.infer<typeof roleItemSchema>;
export type ApiWorkflowItem = z.infer<typeof workflowItemSchema>;

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export type TokenRunInput = z.infer<typeof tokenRunInputSchema>;
export type ProjectRunInput = z.infer<typeof projectRunInputSchema>;
export type ProjectDetailInput = z.infer<typeof projectDetailInputSchema>;
export type DemandShapeInput = z.infer<typeof demandShapeInputSchema>;
export type DemandApproveInput = z.infer<typeof demandApproveInputSchema>;
export type DeliveryCreatePrInput = z.infer<typeof deliveryCreatePrInputSchema>;
export type DeliveryCiStatusInput = z.infer<typeof deliveryCiStatusInputSchema>;
export type DecisionInput = z.infer<typeof decisionInputSchema>;
export type AuditListInput = z.infer<typeof auditListInputSchema>;
export type ReviewGetInput = z.infer<typeof reviewGetInputSchema>;
export type ProgressListInput = z.infer<typeof progressListInputSchema>;

// ---------------------------------------------------------------------------
// Output types (per-procedure)
// ---------------------------------------------------------------------------

export type ProjectOverviewOutput = z.infer<typeof projectOverviewOutputSchema>;
export type ProjectOverviewCounts = z.infer<typeof projectOverviewCountsSchema>;
export type ProjectDetailOutput = z.infer<typeof projectDetailOutputSchema>;
export type RunWrapperOutput = z.infer<typeof runWrapperOutputSchema>;
export type ProjectCleanOutput = z.infer<typeof projectCleanOutputSchema>;

export type DemandShapeOutput = z.infer<typeof demandShapeOutputSchema>;
export type DemandApproveOutput = z.infer<typeof demandApproveOutputSchema>;

export type DeliveryPrepareOutput = z.infer<
  typeof deliveryPrepareOutputSchema
>;
export type DeliveryCreatePrOutput = z.infer<typeof deliveryCreatePrOutputSchema>;

export type ArtifactListOutput = z.infer<typeof artifactListOutputSchema>;
export type GateListOutput = z.infer<typeof gateListOutputSchema>;
export type DecisionOutput = z.infer<typeof decisionOutputSchema>;

export type AuditVerification = z.infer<typeof auditVerificationSchema>;
export type AuditListOutput = z.infer<typeof auditListOutputSchema>;

export type RoleListOutput = z.infer<typeof roleListOutputSchema>;
export type WorkflowListOutput = z.infer<typeof workflowListOutputSchema>;

export type DeliveryDryRunOutput = z.infer<typeof deliveryDryRunOutputSchema>;
export type DeliveryCiCheck = z.infer<typeof deliveryCiCheckSchema>;
export type DeliveryCiStatusOutput = z.infer<typeof deliveryCiStatusOutputSchema>;

export type ProgressFile = z.infer<typeof progressFileSchema>;
export type ProgressListOutput = z.infer<typeof progressListOutputSchema>;
