import type {
  AuditLogger,
  DraftShape,
  HumanApprovalSummary,
  ApprovalSummaryEvaluation,
  TekonDatabase,
  TekonRepositories,
  WorkReviewSurface,
} from '@tekon/core';

import type { WebProjectContext } from '../project-context.js';

export interface ServerContext {
  db: TekonDatabase;
  repositories: TekonRepositories;
  audit: AuditLogger;
  projectContext: WebProjectContext;
}

export interface TokenRunInput {
  runId: string;
  token: string;
}

export interface ProjectRunInput {
  demandText: string;
  token: string;
  template?: string;
  agent?: string;
  allowDirtyBase?: boolean;
  demandShapePath?: string;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  progressHeartbeatMs?: number;
}

export interface DraftShapeInput {
  demandText: string;
  token: string;
}

export interface DraftShapeApproveInput {
  shapePath: string;
  token: string;
  actor?: string;
}

export interface DraftShapeDetailInput {
  shapePath: string;
  token: string;
}

/** @deprecated Use {@link DraftShapeInput} instead */
export type DemandShapeInput = DraftShapeInput;
/** @deprecated Use {@link DraftShapeApproveInput} instead */
export type DemandApproveInput = DraftShapeApproveInput;
/** @deprecated Use {@link DraftShapeDetailInput} instead */
export type DemandDetailInput = DraftShapeDetailInput;

export interface DeliveryCreatePrInput extends TokenRunInput {
  approveHuman: true;
}

export interface DeliveryCiStatusInput {
  runId: string;
  token: string;
  selector?: string;
}

export interface ProjectCleanInput extends TokenRunInput {
  confirm: 'delete-run-dir';
}

export interface DecisionInput {
  runId: string;
  decisionId: string;
  actor: string;
  note?: string;
  token: string;
}

export interface ProjectOutput {
  id: string;
  name: string;
  repoPath: string;
  createdAt: string;
}

export interface WorkflowOutput {
  id: string;
  projectId: string;
  demandId: string;
  status: string;
  currentNodeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ArtifactOutput {
  id: string;
  runId: string;
  nodeId: string;
  type: string;
  version: number;
  path: string;
  sha256: string;
  sizeBytes: number;
  summary: string | null;
  createdAt: string;
}

export interface GateOutput {
  id: string;
  runId: string;
  nodeId: string;
  gateType: string;
  status: string;
  outputPath: string | null;
  durationMs: number;
  retries: number;
  fixAttemptId: string | null;
  failureClassification: string | null;
  createdAt: string;
}

export interface AuditEventOutput {
  id: string;
  runId: string;
  type: string;
  payload: Record<string, unknown>;
  nodeId: string | null;
  gateId: string | null;
  role: string | null;
  prevHash: string | null;
  hash: string;
  createdAt: string;
}

export interface HumanDecisionOutput {
  id: string;
  runId: string;
  nodeId: string;
  gateResultId: string | null;
  status: string;
  actor: string | null;
  note: string | null;
  createdAt: string;
  decidedAt: string | null;
  context: {
    request: string;
    exactCommand: string;
    riskLabel: string;
    nodeRole: string | null;
    approvalSummary: HumanApprovalSummary | null;
    approvalEvaluation: ApprovalSummaryEvaluation | null;
    gate: {
      id: string;
      type: string;
      status: string;
      nodeId: string;
      outputPath: string | null;
      failureClassification: string | null;
    } | null;
  };
}

export interface ApiCaller {
  draftShape: {
    detail(input: DraftShapeDetailInput): Promise<{
      shape: DraftShape;
    }>;
    shape(input: DraftShapeInput): Promise<{
      shape: DraftShape;
      shapePath: string;
      reviewPath: string;
      runText: string;
    }>;
    approve(input: DraftShapeApproveInput): Promise<{
      shape: DraftShape;
      shapePath: string;
    }>;
  };
  /** @deprecated Use {@link ApiCaller.draftShape} instead */
  demand: {
    detail(input: DemandDetailInput): Promise<{
      shape: DraftShape;
    }>;
    shape(input: DraftShapeInput): Promise<{
      shape: DraftShape;
      shapePath: string;
      reviewPath: string;
      runText: string;
    }>;
    approve(input: DemandApproveInput): Promise<{
      shape: DraftShape;
      shapePath: string;
    }>;
  };
  project: {
    list(): Promise<ProjectOutput[]>;
    overview(): Promise<{
      project: ProjectOutput;
      latestRun: WorkflowOutput | null;
      counts: {
        artifacts: number;
        gates: number;
        audit: number;
        pendingApprovals: number;
        roles: number;
        workflows: number;
      };
    }>;
    detail(input: { projectId: string }): Promise<{
      project: ProjectOutput;
      runs: WorkflowOutput[];
    }>;
    pause(input: TokenRunInput): Promise<{ run: WorkflowOutput }>;
    run(input: ProjectRunInput): Promise<{ run: WorkflowOutput }>;
    resume(input: TokenRunInput): Promise<{ run: WorkflowOutput }>;
    cancel(input: TokenRunInput): Promise<{ run: WorkflowOutput }>;
    clean(input: ProjectCleanInput): Promise<{ removedRunDir: boolean }>;
  };
  delivery: {
    prepare(input: TokenRunInput): Promise<{
      runId: string;
      branch: string;
      baseBranch: string;
      packagePath: string;
      prBodyPath: string;
      requiresHumanApproval: true;
    }>;
    createPr(input: DeliveryCreatePrInput): Promise<{
      runId: string;
      deliveryStatus: string;
      requiresHumanApproval: boolean;
      prUrl: string | null;
      failureStage: string | null;
      lastError: string | null;
      branch: string | null;
      baseBranch: string | null;
    }>;
    dryRun(input: TokenRunInput): Promise<{
      runId: string;
      workflowStatus: string;
      artifacts: number;
      gates: { total: number; passed: number };
      pendingHumanDecisions: number;
      deliveryStatus: string;
      readyForPrepare: boolean;
      dryRun: true;
    }>;
    ciStatus(input: DeliveryCiStatusInput): Promise<{
      runId: string;
      status: string;
      checks: Array<{
        name: string;
        state: string | null;
        bucket: string | null;
        workflow?: string | null;
        link?: string | null;
        description?: string | null;
      }>;
      prUrl?: string | null;
      error?: string;
    }>;
  };
  artifact: {
    list(input: {
      runId: string;
    }): Promise<{ artifacts: ArtifactOutput[] }>;
  };
  gate: {
    list(input: { runId: string }): Promise<{
      gates: GateOutput[];
      pendingDecisions: HumanDecisionOutput[];
    }>;
    approve(
      input: DecisionInput,
    ): Promise<{ decision: HumanDecisionOutput }>;
    reject(
      input: DecisionInput,
    ): Promise<{ decision: HumanDecisionOutput }>;
  };
  audit: {
    list(input: {
      runId: string;
      nodeId?: string;
      gateId?: string;
      role?: string;
    }): Promise<{
      verification: { valid: true } | { valid: false; brokenEventId: string };
      events: AuditEventOutput[];
    }>;
  };
  review: {
    get(input: {
      runId: string;
      maxContentChars?: number;
    }): Promise<WorkReviewSurface>;
  };
  role: {
    list(): Promise<{
      roles: Array<{ id: string; name: string; hasSystemPrompt: boolean }>;
    }>;
  };
  workflow: {
    list(): Promise<{
      workflows: Array<{ id: string; name: string; path: string }>;
    }>;
  };
  progress: {
    list(input: { runId: string }): Promise<{
      runId: string;
      progressFiles: Array<{
        nodeId: string | null;
        status: string;
        startedAt: string | null;
        updatedAt: string | null;
        elapsedMs: number;
        timeoutMs: number | null;
        noProgressTimeoutMs: number;
        timeoutReason: string | null;
        lastOutputAt: string | null;
        stdoutBytes: number;
        stderrBytes: number;
        lastOutputDirAt: string | null;
        outputDirFileCount: number;
        heartbeatCount: number;
        approachingTimeout: boolean;
        secondsRemaining: number;
        redactedCommand: string;
      }>;
    }>;
  };
  close(): Promise<void>;
}
