import { useState } from 'react';

import { useMutation } from '../hooks/index.js';
import { useSessionToken } from '../hooks/use-session-token.js';
import { useFlash } from '../context/flash-context.js';
import { rpc } from '../lib/rpc-client.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

import { DraftForm } from '../components/demand/DraftForm.js';
import { DraftCard } from '../components/demand/DraftCard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ShapeOutput = RpcProcedureMap['draftShape.shape']['output'];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * DraftPage — 需求澄清
 *
 * 1. User enters raw demand text in the DraftForm.
 * 2. On submit, the `draftShape.shape` mutation is called to classify and shape it.
 * 3. The resulting DraftShape is rendered as a DraftCard showing
 *    classification tags, risk assessment, acceptance criteria, and non-goals.
 * 4. The user can approve the demand via `draftShape.approve` or navigate to
 *    Runs with the prefilled demand text.
 */
export function DraftPage() {
  const { token } = useSessionToken();
  const { addFlash } = useFlash();

  // ── Shaped demand state (survives re-renders until new shape is produced) ──
  const [shapeResult, setShapeResult] = useState<ShapeOutput | null>(null);
  const [approved, setApproved] = useState(false);

  // ── Shape mutation ──
  const shapeMutation = useMutation<
    RpcProcedureMap['draftShape.shape']['input'],
    RpcProcedureMap['draftShape.shape']['output']
  >((input) => rpc.call('draftShape.shape', input));

  const handleClarify = async (demandText: string) => {
    if (!token) {
      addFlash('warning', '请先设置会话令牌');
      return;
    }

    try {
      const result = await shapeMutation.mutate({ demandText, token });
      setShapeResult(result);
      setApproved(false);
      addFlash('success', '需求已澄清');
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : '需求分析失败',
      );
    }
  };

  const handleApproved = (
    result: RpcProcedureMap['draftShape.approve']['output'],
  ) => {
    setShapeResult((prev) =>
      prev
        ? { ...prev, shape: result.shape, shapePath: result.shapePath }
        : prev,
    );
    setApproved(true);
  };

  return (
    <>
      {/* ── Page Header ── */}
      <header className="page-header">
        <div>
          <h1 className="page-title">需求澄清</h1>
          <p className="page-subtitle">
            需求分析与澄清 · 运行前明确需求、评估并批准

          </p>
        </div>
      </header>

      {/* ── Input Form ── */}
      <DraftForm
        onSubmit={handleClarify}
        isPending={shapeMutation.isPending}
        error={shapeMutation.error?.message ?? null}
      />

      {/* ── Shaped Demand Result ── */}
      {shapeResult && (
        <>
          <div
            className="section-title"
            style={{ fontFamily: 'var(--font-d)', fontSize: 15, fontWeight: 600, marginBottom: 12 }}
          >
            已澄清需求
          </div>

          <DraftCard
            shape={shapeResult.shape}
            shapePath={shapeResult.shapePath}
            approved={approved}
            onApproved={handleApproved}
          />
        </>
      )}

      {/* ── Empty state ── */}
      {!shapeResult && !shapeMutation.isPending && (
        <div className="card">
          <div className="card-body">
            <p
              className="text-muted"
              style={{ textAlign: 'center', padding: '24px 0' }}
            >
              输入需求描述并点击"澄清需求"来分析和结构化你的需求。
            </p>
          </div>
        </div>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Backward-compatible deprecated export
// ---------------------------------------------------------------------------

/** @deprecated Use DraftPage instead */
export const DemandPage = DraftPage;
