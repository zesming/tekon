import { useState } from 'react';

import { useMutation } from '../hooks/index.js';
import { useSessionToken } from '../hooks/use-session-token.js';
import { useFlash } from '../context/flash-context.js';
import { rpc } from '../lib/rpc-client.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

import { DemandForm } from '../components/demand/DemandForm.js';
import { DemandShapeCard } from '../components/demand/DemandShapeCard.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ShapeOutput = RpcProcedureMap['demand.shape']['output'];

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

/**
 * DemandPage — 需求澄清
 *
 * 1. User enters raw demand text in the DemandForm.
 * 2. On submit, the `demand.shape` mutation is called to classify and shape it.
 * 3. The resulting DemandShape is rendered as a DemandShapeCard showing
 *    classification tags, risk assessment, acceptance criteria, and non-goals.
 * 4. The user can approve the demand via `demand.approve` or navigate to
 *    Runs with the prefilled demand text.
 */
export function DemandPage() {
  const { token } = useSessionToken();
  const { addFlash } = useFlash();

  // ── Shaped demand state (survives re-renders until new shape is produced) ──
  const [shapeResult, setShapeResult] = useState<ShapeOutput | null>(null);
  const [approved, setApproved] = useState(false);

  // ── Shape mutation ──
  const shapeMutation = useMutation<
    RpcProcedureMap['demand.shape']['input'],
    RpcProcedureMap['demand.shape']['output']
  >((input) => rpc.call('demand.shape', input));

  const handleClarify = async (demandText: string) => {
    if (!token) {
      addFlash('warning', 'Please set your session token first');
      return;
    }

    try {
      const result = await shapeMutation.mutate({ demandText, token });
      setShapeResult(result);
      setApproved(false);
      addFlash('success', '需求已澄清 Demand shaped successfully');
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : 'Failed to shape demand',
      );
    }
  };

  const handleApproved = (
    result: RpcProcedureMap['demand.approve']['output'],
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
          <h1 className="page-title">需求澄清 Demand</h1>
          <p className="page-subtitle">
            需求分析与澄清 · Clarify, evaluate, and approve demands before
            running
          </p>
        </div>
      </header>

      {/* ── Input Form ── */}
      <DemandForm
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
            已澄清需求 Clarified Demand
          </div>

          <DemandShapeCard
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
              输入需求描述并点击"澄清需求 Clarify"来分析和结构化你的需求。
            </p>
          </div>
        </div>
      )}
    </>
  );
}
