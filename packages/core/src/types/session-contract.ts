import { z } from 'zod';

/**
 * Session/Event/Agent contract — schema v1.
 *
 * This is the "contract freeze" from the Harness-inspired replatform plan
 * (docs/superpowers/plans/2026-08-20-harness-replatform-execution-plan.md). It
 * defines the shared vocabulary and interfaces. As of phases 1–4 it is wired
 * into the running engine: SessionService, the job runner, the dual-write
 * session-event store and the LegacyAgentDriver all build against these types
 * (the streaming AgentHandle below is provided by the phase-2a legacy bridge as
 * a one-shot adapter; true incremental streaming / follow-up / steer remain
 * later-phase work — see the AgentHandle docs).
 *
 * Design provenance:
 * - Event vocabulary mirrors the DeepSeek Harness session model (append-only
 *   typed SessionEvent log; model history derived from the log; turn = one user
 *   input, step = one model call + its tool executions). Verified against the
 *   official docs/subsystems/session.md and docs/architecture.md.
 * - Governance events (workflow/gate/artifact/worktree/delivery/evaluation) are
 *   Tekon-specific extensions layered on the same log, per report §8.3.
 *
 * Compatibility rules (report §8.3):
 * - Every event is JSON-serializable and carries an explicit schema version.
 * - Events carry a per-session monotonic sequence number.
 * - Projections render UI from the log; the UI never stitches together several
 *   inconsistent endpoints.
 * - Unknown event types are ignorable; a small required core must be present.
 */

export const SESSION_EVENT_SCHEMA_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Core session objects (report §8.2)
// ---------------------------------------------------------------------------

export const workspaceSchema = z.object({
  id: z.string().min(1),
  root: z.string().min(1),
  repo: z.string().nullable(),
  branchPolicy: z.string().nullable(),
  permissionProfile: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const sessionStatusSchema = z.enum([
  'active',
  'idle',
  'awaiting-input',
  'awaiting-approval',
  'cancelled',
  'failed',
  'done',
]);
export type SessionStatus = z.infer<typeof sessionStatusSchema>;

export const sessionSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  title: z.string().nullable(),
  profile: z.string(),
  status: sessionStatusSchema,
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Session = z.infer<typeof sessionSchema>;

/** Event visibility: does this event's content enter the model context? */
export const eventVisibilitySchema = z.enum(['model', 'ui-only', 'internal']);
export type EventVisibility = z.infer<typeof eventVisibilitySchema>;

export const sessionEventSchema = z.object({
  sessionId: z.string().min(1),
  /** Per-session monotonic sequence number. */
  seq: z.number().int().nonnegative(),
  type: z.string().min(1),
  version: z.literal(SESSION_EVENT_SCHEMA_VERSION),
  timestamp: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()).default({}),
  visibility: eventVisibilitySchema.default('ui-only'),
  /** True when this event's content is part of the model-visible history. */
  modelVisible: z.boolean().default(false),
  /** Source event seqs this one derives from (e.g. projection/correlation). */
  sourceEventSeqs: z.array(z.number().int().nonnegative()).default([]),
  correlationId: z.string().nullable().default(null),
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const jobStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'cancelling',
  'cancelled',
  'interrupted',
  'failed',
  'done',
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  kind: z.string().min(1),
  status: jobStatusSchema,
  owner: z.string().nullable(),
  lease: z.string().nullable(),
  abortState: z
    .enum(['none', 'requested', 'propagated', 'stopped'])
    .default('none'),
  checkpoint: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});
export type Job = z.infer<typeof jobSchema>;

// ---------------------------------------------------------------------------
// Event vocabulary (report §8.3) — string constants, not an enum, so plugins
// can merge additional event types (Harness "merge-extensible" model).
// ---------------------------------------------------------------------------

/** Base session/agent-loop events (mirror Harness core vocabulary). */
export const CORE_SESSION_EVENT_TYPES = [
  'session/created',
  'turn/start',
  'turn/end',
  'step/start',
  'step/end',
  'user/message',
  'assistant/chunk',
  'assistant/message',
  'agent/status',
  'agent/error',
  'plan/updated',
  'todo/updated',
] as const;

/** Tool and control events. */
export const CONTROL_EVENT_TYPES = [
  'tool/call',
  'tool/result',
  'tool/progress',
  'approval/requested',
  'approval/decided',
  'agent/steered',
  'agent/cancel-requested',
  'agent/cancelled',
  'job/checkpointed',
  // Emitted by the durable job runner (notifySettled) when a job reaches a
  // terminal state; payload {jobId, kind, status}. Same family as
  // job/checkpointed — runner lifecycle, not agent-loop content.
  'job/status',
] as const;

/** Tekon governance extensions (layered on the same append-only log). */
export const TEKON_GOVERNANCE_EVENT_TYPES = [
  'workflow/started',
  'workflow/node-started',
  'workflow/node-ended',
  'gate/started',
  'gate/result',
  'artifact/created',
  'artifact/versioned',
  'worktree/leased',
  'worktree/released',
  'delivery/prepared',
  'delivery/pr-created',
  'evaluation/completed',
  // 4e: emitted after pre-PR readiness is (re-)evaluated off a gate/result
  // event, so UI/delivery can react to readiness changes without polling.
  'readiness/evaluated',
] as const;

export type CoreSessionEventType = (typeof CORE_SESSION_EVENT_TYPES)[number];
export type ControlEventType = (typeof CONTROL_EVENT_TYPES)[number];
export type TekonGovernanceEventType =
  (typeof TEKON_GOVERNANCE_EVENT_TYPES)[number];
export type KnownSessionEventType =
  | CoreSessionEventType
  | ControlEventType
  | TekonGovernanceEventType;

/** Minimal required core an implementation must always produce/understand. */
export const REQUIRED_EVENT_TYPES: readonly KnownSessionEventType[] = [
  'session/created',
  'turn/start',
  'turn/end',
  'user/message',
  'assistant/message',
] as const;

// ---------------------------------------------------------------------------
// Runtime interfaces (report §8.4) — signatures only, no implementation.
// ---------------------------------------------------------------------------

export interface UserMessage {
  text: string;
  attachments?: ReadonlyArray<{ id: string; kind: string; ref: string }>;
}

export interface AgentRuntimeEvent {
  type: KnownSessionEventType | string;
  seq: number;
  payload: Record<string, unknown>;
}

export interface AgentOutcome {
  status: 'done' | 'failed' | 'cancelled';
  summary?: string;
}

export interface PauseResult {
  paused: boolean;
  /** Whether the currently-running tool could be interrupted at a checkpoint. */
  interruptible: boolean;
}

export interface AgentStartInput {
  sessionId: string;
  message: UserMessage;
  profile?: string;
}

export interface AgentResumeInput {
  sessionId: string;
  fromSeq?: number;
}

/**
 * Streaming agent handle — replaces the one-shot
 * `runAgent(): Promise<AgentRunResult>` (report §8.4 / P0-04). Phase 2a
 * provides this via a legacy bridge (LegacyAgentDriver) that wraps the current
 * adapter as a single opaque step, so Codex/Claude adapters need not be
 * rewritten at once. Note the bridge is one-shot: events() yields the buffered
 * sequence once the run settles, and followUp()/steer()/resume() throw
 * NotSupportedYet — true incremental streaming and in-session follow-up/steer
 * are later-phase work.
 */
export interface AgentHandle {
  readonly id: string;
  events(): AsyncIterable<AgentRuntimeEvent>;
  followUp(message: UserMessage): Promise<void>;
  steer(message: UserMessage): Promise<void>;
  pause(): Promise<PauseResult>;
  cancel(reason?: string): Promise<void>;
  whenIdle(): Promise<AgentOutcome>;
}

export interface AgentDriver {
  start(input: AgentStartInput): Promise<AgentHandle>;
  resume(input: AgentResumeInput): Promise<AgentHandle>;
}

/**
 * Durable background job runner (report §8.1/§P0-01). `start` persists a
 * session/job and returns immediately; the runner drives the agent loop
 * out-of-band and streams events, instead of the current long blocking RPC.
 */
export interface JobRunner {
  enqueue(input: { sessionId: string; kind: string }): Promise<Job>;
  /**
   * F5-P0-01/F6: atomically enqueue a run-execution job for `runId` only
   * if that run has no active run-execution job. Automation/projection jobs are
   * a separate control domain and do not block pause/resume/cancel. Collapses
   * the resume-path find-active + enqueue into one
   * cross-process critical section (see JobRepository.enqueueIfNoActiveByRunId).
   */
  enqueueIfNoActiveByRunId(input: {
    runId: string;
    sessionId: string;
    kind: string;
  }): Promise<
    { outcome: 'enqueued'; job: Job } | { outcome: 'active-job'; job: Job }
  >;
  get(jobId: string): Promise<Job | null>;
  requestCancel(jobId: string, reason?: string): Promise<void>;
  checkpoint(jobId: string, checkpoint: string): Promise<void>;
}

/** Append-only session event subscription (SSE/WebSocket transport later). */
export interface EventSubscription {
  /** Replay from `sinceSeq` (exclusive), then stream live events. */
  subscribe(sessionId: string, sinceSeq: number): AsyncIterable<SessionEvent>;
}

/** Read-model projected from the event log (report §8.2 Projection). */
export interface Projection<T> {
  readonly name: string;
  /** Fold a batch of events into the projected read-model. */
  project(events: ReadonlyArray<SessionEvent>): T;
}
