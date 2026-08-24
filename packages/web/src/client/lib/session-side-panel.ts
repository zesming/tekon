import type { StreamEvent } from './session-stream.js';

/**
 * Phase 3 3c: derive the right-rail state (run id/status, pending approvals,
 * result cards) from the session event stream. Pure so it can be unit-tested;
 * the React side panel renders it and wires inline approval to gate.approve/
 * reject (governance semantics unchanged — the client is just a new entry point).
 */

export interface SidePanelCard {
  seq: number;
  kind: 'artifact' | 'tool' | 'error';
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

function str(payload: Record<string, unknown>, key: string): string | undefined {
  const value = payload[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
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

  return {
    runId,
    runStatus,
    pendingDecisionIds,
    hasPendingApproval: pendingDecisionIds.length > 0,
    cards,
  };
}
