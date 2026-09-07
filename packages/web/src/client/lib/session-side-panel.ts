import type { StreamEvent } from './session-stream.js';

/**
 * Phase 3 3c: derive the right-rail state (run id/status, pending approvals,
 * result cards) from the session event stream. Pure so it can be unit-tested;
 * the React side panel renders it and wires inline approval to gate.approve/
 * reject (governance semantics unchanged — the client is just a new entry point).
 */

// Run statuses that mean the run is finished (matches core's
// TERMINAL_WORKFLOW_STATUSES). Only these get a final-result summary card.
const TERMINAL_RUN_STATUSES = new Set(['passed', 'failed', 'cancelled']);

export interface SidePanelCard {
  seq: number;
  kind: 'artifact' | 'tool' | 'error' | 'result';
  title: string;
  detail?: string;
}

export interface SidePanelState {
  runId: string | null;
  /** Derived run status for RunControls affordances (null when unknown). */
  runStatus: string | null;
  pendingDecisionIds: string[];
  hasPendingApproval: boolean;
  cards: SidePanelCard[];
}

export interface SessionSidePanelSnapshot {
  runId?: string | null;
  status?: string | null;
  actionKind?: string | null;
}

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * Session rows and workflow runs use different status vocabularies. Translate
 * only the states with an unambiguous RunControls meaning; an unknown value
 * remains null so the UI fails closed instead of fabricating live controls.
 */
function runStatusFromSessionStatus(
  status: string | null | undefined,
): string | null {
  switch (status) {
    case 'active':
      return 'running';
    case 'idle':
      return 'paused';
    case 'awaiting-input':
      return 'blocked';
    case 'awaiting-approval':
      return 'awaiting-approval';
    case 'done':
      return 'passed';
    case 'cancelled':
    case 'failed':
      return status;
    default:
      return null;
  }
}

/**
 * The event spine is explicitly best-effort during the migration. Session.get
 * is therefore the safe point-in-time fallback for the run binding, lifecycle
 * status, and attention state before SSE catches up or when a projection event
 * is absent. Live events always win once present.
 */
export function mergeSessionSnapshotIntoSidePanel(
  state: SidePanelState,
  snapshot: SessionSidePanelSnapshot,
): SidePanelState {
  return {
    ...state,
    runId: state.runId ?? snapshot.runId ?? null,
    runStatus:
      state.runStatus ?? runStatusFromSessionStatus(snapshot.status) ?? null,
    hasPendingApproval:
      state.hasPendingApproval ||
      snapshot.actionKind === 'approval' ||
      snapshot.status === 'awaiting-approval',
  };
}

export function deriveSessionSidePanel(
  events: readonly StreamEvent[],
): SidePanelState {
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  let runId: string | null = null;
  let runStatus: string | null = null;
  const pending = new Map<string, true>();
  const cards: SidePanelCard[] = [];

  for (const event of sorted) {
    const p = event.payload ?? {};
    const rid = str(p, 'runId');
    if (rid) runId = rid;

    switch (event.type) {
      case 'workflow/started':
        runStatus = 'running';
        break;
      case 'step/start':
        runStatus = 'running';
        break;
      case 'approval/requested': {
        const id = str(p, 'decisionId');
        if (id) pending.set(id, true);
        break;
      }
      case 'approval/decided': {
        const id = str(p, 'decisionId');
        if (id) pending.delete(id);
        break;
      }
      // Terminal / paused lifecycle signals (M1). Without these the derived
      // status stays 'running' forever, so RunControls shows pause/cancel on a
      // finished run and resume is never reachable. turn/end carries the
      // authoritative final status; 'terminal' is a no-status-change marker
      // (job-executor emits it when the run was already terminal) → ignore it.
      case 'turn/end': {
        const status = str(p, 'status');
        if (status && status !== 'terminal') {
          runStatus = status;
        }
        break;
      }
      case 'agent/status': {
        const status = str(p, 'status');
        if (status) runStatus = status;
        break;
      }
      case 'agent/cancelled':
        // A queued job cancelled before executor start emits no turn/end.
        runStatus = 'cancelled';
        break;
      case 'artifact/created':
        cards.push({
          seq: event.seq,
          kind: 'artifact',
          title: str(p, 'artifactType') ?? str(p, 'type') ?? 'artifact',
          detail: str(p, 'artifactId') ?? str(p, 'path'),
        });
        break;
      case 'tool/result':
        cards.push({
          seq: event.seq,
          kind: 'tool',
          title: str(p, 'name') ?? str(p, 'tool') ?? 'tool result',
          detail: p._truncated === true ? '（已截断）' : str(p, 'summary'),
        });
        break;
      case 'agent/error':
        cards.push({
          seq: event.seq,
          kind: 'error',
          title: 'agent error',
          detail: str(p, 'message') ?? str(p, 'error'),
        });
        break;
      default:
        break;
    }
  }

  // A pending human decision means the run is awaiting approval, regardless of
  // the last lifecycle signal seen.
  const pendingDecisionIds = [...pending.keys()];
  if (pendingDecisionIds.length > 0) {
    runStatus = 'awaiting-approval';
  }

  // Report item 6 "final-result card": once the run is terminal, close the rail
  // with a summary synthesized from data that genuinely exists in the stream —
  // the terminal status plus the artifact/error counts already collected. (A
  // richer delivery/PR summary needs delivery-event subscription, deferred to
  // phase 4; turn/end carries only {runId, status} today.) Sorted last via a
  // seq above every real event so it reads as the closing line.
  if (runStatus && TERMINAL_RUN_STATUSES.has(runStatus)) {
    const artifactCount = cards.filter((c) => c.kind === 'artifact').length;
    const errorCount = cards.filter((c) => c.kind === 'error').length;
    const lastSeq = cards.reduce((max, c) => Math.max(max, c.seq), 0);
    cards.push({
      seq: lastSeq + 1,
      kind: 'result',
      title: `运行结束 · ${runStatus}`,
      detail: `产物 ${artifactCount} · 错误 ${errorCount}`,
    });
  }

  return {
    runId,
    runStatus,
    pendingDecisionIds,
    hasPendingApproval: pendingDecisionIds.length > 0,
    cards,
  };
}
