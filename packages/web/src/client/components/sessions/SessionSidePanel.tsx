import { useCallback, useMemo, useState } from 'react';

import {
  useQuery,
  useMutation,
  useAuthScope,
  useSessionToken,
} from '../../hooks/index.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
import type {
  SidePanelCard,
  SidePanelState,
} from '../../lib/session-side-panel.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';
import type { DecisionInput, DecisionOutput } from '../../../shared/api-types.js';

import { RunControls } from '../runs/RunControls.js';
import { DecisionCard } from '../approvals/DecisionCard.js';
import { CodeBlock } from '../ui/CodeBlock.js';

// Phase 3 3c: right rail — run controls + inline approval + result cards,
// driven by the session event stream. The page owns the pure event projection
// so the header and right rail consume one coherent live state instead of
// independently scanning and interpreting the same history.

const CARD_LABEL: Record<SidePanelCard['kind'], string> = {
  artifact: '产物',
  tool: '工具',
  error: '错误',
  result: '结果',
};
const DEFAULT_SUPPORTING_CARD_LIMIT = 6;

export function SessionSidePanel({ state }: { state: SidePanelState }) {
  const scope = useAuthScope();
  const { token } = useSessionToken();
  const flash = useFlash();
  const runId = state.runId;
  const [showAllCards, setShowAllCards] = useState(false);

  // Full decision context (risk, command, approvalSummary) lives in gate.list —
  // approval/requested only carries ids (S1). Fetch it when an approval pends.
  // Invalidate the actual gate-results key prefix (queryKeys.gateResults =
  // "gate.results."), not "gate.list", so a decision refetches the context.
  const invalidateKeys = ['gate.results.', 'session.list.', 'project.overview'];
  const { data: gateData, refetch } = useQuery<
    RpcProcedureMap['gate.list']['output']
  >(
    runId && state.hasPendingApproval
      ? queryKeys.gateResults(runId, scope)
      : null,
    () => rpc.call('gate.list', { runId: runId! }),
  );

  const approveMutation = useMutation<DecisionInput, DecisionOutput>(
    (input) => rpc.call('gate.approve', input),
    { invalidateKeys },
  );
  const rejectMutation = useMutation<DecisionInput, DecisionOutput>(
    (input) => rpc.call('gate.reject', input),
    { invalidateKeys },
  );
  const isPending = approveMutation.isPending || rejectMutation.isPending;

  const decide = useCallback(
    async (
      mutation: typeof approveMutation,
      verb: string,
      decisionId: string,
      note: string,
    ) => {
      if (!token || !runId) {
        flash.addFlash('error', '请先在顶栏设置会话令牌');
        return;
      }
      try {
        await mutation.mutate({
          runId,
          decisionId,
          actor: 'web-user',
          note: note || undefined,
          token,
        });
        flash.addFlash('success', `Decision ${decisionId} ${verb}`);
        refetch();
      } catch (err) {
        flash.addFlash(
          'error',
          `${verb} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    },
    [token, runId, flash, refetch],
  );

  // Card existence is driven by the derived pending set (stable while the run
  // is paused), and its rich context is filled from gate.list once loaded.
  // Deriving existence from gateData alone would unmount/remount the card on a
  // transient refetch, resetting DecisionForm's two-step state mid-approval.
  const gateById = new Map(
    (gateData?.pendingDecisions ?? []).map((d) => [d.id, d]),
  );
  const pendingDecisions = state.pendingDecisionIds
    .map((id) => gateById.get(id))
    .filter((d): d is NonNullable<typeof d> => Boolean(d));

  // The inspector should answer "what is true now", not repeat the full feed.
  // Keep terminal results and errors visible, then show only the latest few
  // supporting artifact/tool cards until the user explicitly expands history.
  const { visibleCards, hiddenSupportingCount, hasCollapsibleHistory } =
    useMemo(() => {
      const results = state.cards.filter((card) => card.kind === 'result');
      const errors = state.cards.filter((card) => card.kind === 'error');
      const supporting = state.cards.filter(
        (card) => card.kind === 'artifact' || card.kind === 'tool',
      );
      const hiddenCount = Math.max(
        0,
        supporting.length - DEFAULT_SUPPORTING_CARD_LIMIT,
      );
      const shownSupporting = showAllCards
        ? supporting
        : supporting.slice(-DEFAULT_SUPPORTING_CARD_LIMIT);
      return {
        visibleCards: [...results, ...errors, ...shownSupporting],
        hiddenSupportingCount: hiddenCount,
        hasCollapsibleHistory:
          supporting.length > DEFAULT_SUPPORTING_CARD_LIMIT,
      };
    }, [showAllCards, state.cards]);

  return (
    <div className="session-side">
      {runId ? (
        <div className="card session-side-controls">
          <div className="card-body">
            <RunControls
              runId={runId}
              status={state.runStatus ?? 'running'}
            />
          </div>
        </div>
      ) : null}

      {pendingDecisions.length > 0 ? (
        <div className="session-side-approvals" data-testid="session-approvals">
          {pendingDecisions.map((decision) => (
            <DecisionCard
              key={decision.id}
              decision={decision}
              isPending={isPending}
              onApprove={(id, note) =>
                decide(approveMutation, 'approved', id, note)
              }
              onReject={(id, note) =>
                decide(rejectMutation, 'rejected', id, note)
              }
            />
          ))}
        </div>
      ) : null}

      {visibleCards.length > 0 ? (
        <div className="session-side-cards">
          {visibleCards.map((card) => (
            <div
              className={`card session-card session-card-${card.kind}`}
              key={card.seq}
            >
              <div className="card-body">
                <div className="session-card-head">
                  <span className="session-card-kind">
                    {CARD_LABEL[card.kind]}
                  </span>
                  <span className="session-card-title">{card.title}</span>
                </div>
                {card.detail ? (
                  <CodeBlock content={card.detail} truncated />
                ) : null}
              </div>
            </div>
          ))}
          {hasCollapsibleHistory ? (
            <button
              type="button"
              className="btn btn-ghost btn-sm session-side-card-toggle"
              aria-expanded={showAllCards}
              onClick={() => setShowAllCards((value) => !value)}
            >
              {showAllCards
                ? '收起工具与产物历史'
                : `显示另外 ${hiddenSupportingCount} 条工具与产物历史`}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
