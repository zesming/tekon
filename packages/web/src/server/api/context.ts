import type {
  AuditLogger,
  DraftShape,
  DurableJobRunner,
  HumanApprovalSummary,
  ApprovalSummaryEvaluation,
  JobRepository,
  SessionEventBus,
  SessionEventStore,
  SessionService,
  SubprocessRegistry,
  TekonDatabase,
  TekonRepositories,
  WorkReviewSurface,
  RunPlan,
  RunPlanPreview,
  RunPlanPreviewSigner,
  ExecutionBinding,
  PresentedEvent,
} from '@tekon/core';

import type { WebProjectContext } from '../project-context.js';
import { webProjectScope, type WebProjectScope } from './queries.js';

/**
 * Per-request knobs for the web run-engine factory (4a). The factory is
 * injected into SessionService at the composition root and encapsulates the
 * web provider/adapter construction (createWebAgentRuntime +
 * providerRuntimeFromRunInput + gate/worktree managers).
 */
export interface WebRunEngineInput {
  agent: string;
  profile?: string;
  allowDirtyBase: boolean;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  progressHeartbeatMs?: number;
  acknowledgeUnrestrictedNetwork?: boolean;
  planDigest?: string;
  canonicalPlan?: RunPlan;
  planSnapshot?: string;
}

/**
 * Review surface as returned by the web API: the core surface plus the run's
 * real provider, enriched at the web layer (report §6.4/P1.4). Null when no
 * provider snapshot was recorded for the run.
 */
export type WorkReviewSurfaceOutput = WorkReviewSurface & {
  executionBinding?: ExecutionBinding;
  admissionState?: 'accepted' | 'recovery-required';
  filesState?: 'pending' | 'ready' | 'recovery_required';
  provider: string | null;
};

export interface ServerContext {
  planPreviewSigner: RunPlanPreviewSigner;
  db: TekonDatabase;
  /** Dual-write wrapped repositories (S7a): engine/routers get dual-write for free. */
  repositories: TekonRepositories;
  /** Dual-write wrapped audit logger (S7a). */
  audit: AuditLogger;
  projectContext: WebProjectContext;
  // Event-spine deps (S7a). Present on every router's context.
  sessions: SessionEventStore;
  bus: SessionEventBus;
  jobs: JobRepository;
  jobRunner: DurableJobRunner;
  registry: SubprocessRegistry;
  /** 4a: extracted run/resume/cancel/pause orchestration. */
  sessionService: SessionService<WebRunEngineInput>;
}

export interface TokenRunInput {
  runId: string;
  token: string;
}

export interface ProjectRunInput {
  demandText: string;
  token: string;
  requestId?: string;
  mode?: 'workflow' | 'goal';
  profile?: 'human-web' | 'autonomous-delivery';
  template?: string;
  agent?: string;
  allowDirtyBase?: boolean;
  demandShapePath?: string;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  progressHeartbeatMs?: number;
  acknowledgeUnrestrictedNetwork?: boolean;
  planDigest?: string;
}

export type ProjectRunIntent = Omit<ProjectRunInput, 'token' | 'requestId'>;

export type ProjectAdmissionOutput =
  | { state: 'not-found'; requestId: string }
  | {
      state: 'accepted' | 'recovery-required';
      requestId: string;
      runId: string;
      sessionId?: string;
      jobId?: string;
      filesState: 'pending' | 'ready' | 'recovery_required';
      detail?: string;
    };

export interface WorkflowPlanInput {
  template?: string;
  mode?: 'workflow' | 'goal';
  agent?: string;
  profile?: 'human-web' | 'autonomous-delivery';
  allowDirtyBase?: boolean;
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

// 4f-2: plan flow. generatePlan freezes the plan view (no actor); planApprove
// is a separate approval carrying the approving actor.
export interface DraftShapeGeneratePlanInput {
  shapePath: string;
  token: string;
}

export interface DraftShapePlanApproveInput {
  shapePath: string;
  token: string;
  actor?: string;
}

export interface DraftShapeDetailInput {
  shapePath: string;
  token: string;
}

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
  executionBinding?: ExecutionBinding;
  id: string;
  projectId: string;
  demandId: string;
  demandTitle: string | null;
  provider: string | null;
  status: string;
  currentNodeId: string | null;
  createdAt: string;
  updatedAt: string;
  admissionState?: 'accepted' | 'recovery-required';
  filesState?: 'pending' | 'ready' | 'recovery_required';
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
  [webProjectScope]: WebProjectScope;
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
    // 4f-2: plan flow.
    generatePlan(input: DraftShapeGeneratePlanInput): Promise<{
      shape: DraftShape;
      shapePath: string;
    }>;
    planApprove(input: DraftShapePlanApproveInput): Promise<{
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
    pause(input: TokenRunInput): Promise<{
      run: WorkflowOutput;
      sessionId?: string;
      jobId?: string;
    }>;
    run(input: ProjectRunInput): Promise<{
      run: WorkflowOutput;
      sessionId?: string;
      jobId?: string;
      requestId: string;
      replayed: boolean;
      admissionState: 'accepted' | 'recovery-required';
      detail?: string;
    }>;
    admission(input: { token: string; requestId: string }): Promise<ProjectAdmissionOutput>;
    admissionIntent(input: { token: string; run?: ProjectRunIntent }): Promise<{
      scope: string;
      fingerprint?: string;
      requestId?: string;
    }>;
    resume(input: TokenRunInput): Promise<{
      run: WorkflowOutput;
      sessionId?: string;
      jobId?: string;
    }>;
    cancel(input: TokenRunInput): Promise<{
      run: WorkflowOutput;
      sessionId?: string;
      jobId?: string;
    }>;
    clean(input: ProjectCleanInput): Promise<{ removedRunDir: boolean }>;
    health(input?: { token?: string }): Promise<{
      credential: 'not-configured' | 'valid' | 'invalid';
      checkedAt: string;
      detail?: string;
      dshHeadless?: 'available' | 'unavailable';
    }>;
    providerHealth(input: {
      token: string;
      provider: 'dsh-headless';
      refresh?: boolean;
    }): Promise<{
      provider: 'dsh-headless';
      status: 'available' | 'unavailable';
      checkedAt: string;
      expiresAt: string;
    }>;
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
    list(input: { runId: string }): Promise<{ artifacts: ArtifactOutput[] }>;
  };
  gate: {
    list(input: { runId: string }): Promise<{
      gates: GateOutput[];
      pendingDecisions: HumanDecisionOutput[];
    }>;
    approve(input: DecisionInput): Promise<{
      decision: HumanDecisionOutput;
      sessionId?: string;
      jobId?: string;
    }>;
    reject(input: DecisionInput): Promise<{ decision: HumanDecisionOutput }>;
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
    }): Promise<WorkReviewSurfaceOutput>;
  };
  role: {
    list(): Promise<{
      roles: Array<{ id: string; name: string; hasSystemPrompt: boolean }>;
    }>;
  };
  workflow: {
    list(): Promise<{
      workflows: Array<{
        id: string;
        name: string;
        path?: string;
        builtin?: boolean;
      }>;
    }>;
    plan(input: WorkflowPlanInput): Promise<RunPlanPreview>;
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
  /** Phase 3 3a: session read-path (Session List + Detail metadata). */
  session: {
    list(): Promise<{
      workspaceId: string;
      sessions: Array<{
        admissionState?: 'accepted' | 'recovery-required';
        filesState?: 'pending' | 'ready' | 'recovery_required';
        id: string;
        workspaceId: string;
        title: string | null;
        profile: string;
        status: string;
        runId: string | null;
        createdAt: string;
        updatedAt: string;
        lastActivityAt: string;
        needsAction: boolean;
        actionKind: string | null;
        acknowledgedAt?: string | null;
      }>;
    }>;
    get(input: { sessionId: string }): Promise<{
      session: {
        admissionState?: 'accepted' | 'recovery-required';
        filesState?: 'pending' | 'ready' | 'recovery_required';
        id: string;
        workspaceId: string;
        title: string | null;
        profile: string;
        status: string;
        runId: string | null;
        createdAt: string;
        updatedAt: string;
        lastActivityAt: string;
        needsAction: boolean;
        actionKind: string | null;
        acknowledgedAt?: string | null;
      };
    }>;
    acknowledge(input: { sessionId: string }): Promise<{
      acknowledgedAt: string | null;
    }>;
    events(input: {
      sessionId: string;
      sinceSeq?: number;
      beforeSeq?: number;
      limit?: number;
    }): Promise<{
      events: PresentedEvent[];
      hasMore: boolean;
      latestSeq: number;
      nextBeforeSeq?: number | null;
    }>;
  };
  /**
   * Event-spine handles exposed for the SSE transport (S8, SHOULD15). http.ts
   * uses these to serve GET /api/sessions/:id/events after its security checks.
   */
  sessions: SessionEventStore;
  bus: SessionEventBus;
  close(): Promise<void>;
}
