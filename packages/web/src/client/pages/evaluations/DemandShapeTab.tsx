import { useState } from 'react';

import { useMutation, useSessionToken } from '../../hooks/index.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ShapeOutput = RpcProcedureMap['demand.shape']['output'];

// ---------------------------------------------------------------------------
// DemandShapeTab
// ---------------------------------------------------------------------------

/**
 * DemandShapeTab — evaluate demand shape/structure.
 *
 * Uses the `demand.shape` procedure to analyze and classify a demand,
 * returning a structured shape with risk assessment and acceptance criteria.
 */
export function DemandShapeTab() {
  const { token } = useSessionToken();
  const { addFlash } = useFlash();

  // ── Local state ──
  const [demandText, setDemandText] = useState('');
  const [shapeResult, setShapeResult] = useState<ShapeOutput | null>(null);

  // ── Shape mutation ──
  const shapeMutation = useMutation<
    RpcProcedureMap['demand.shape']['input'],
    RpcProcedureMap['demand.shape']['output']
  >((input) => rpc.call('demand.shape', input));

  const handleEvaluate = async () => {
    if (!token) {
      addFlash('warning', 'Please set your session token first');
      return;
    }
    if (!demandText.trim()) {
      addFlash('warning', 'Please enter demand text');
      return;
    }

    try {
      const result = await shapeMutation.mutate({ demandText: demandText.trim(), token });
      setShapeResult(result);
      addFlash('success', 'Demand shape evaluated');
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : 'Failed to evaluate demand shape',
      );
    }
  };

  const shape = shapeResult?.shape;

  return (
    <>
      {/* ── Input Section ── */}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="card-body">
          <label
            htmlFor="demand-shape-text"
            style={{
              display: 'block',
              fontSize: 12,
              fontWeight: 500,
              color: 'var(--text-s)',
              marginBottom: 4,
            }}
          >
            Demand Text
          </label>
          <textarea
            id="demand-shape-text"
            className="input"
            rows={4}
            placeholder="Enter demand description to evaluate its shape…"
            value={demandText}
            onChange={(e) => setDemandText(e.target.value)}
            style={{ resize: 'vertical', fontFamily: 'var(--font-b)' }}
          />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleEvaluate}
              disabled={shapeMutation.isPending}
            >
              {shapeMutation.isPending ? 'Evaluating…' : 'Evaluate Shape'}
            </button>
          </div>
          {shapeMutation.error && (
            <p style={{ color: 'var(--fail)', fontSize: 12, marginTop: 6 }}>
              {shapeMutation.error.message}
            </p>
          )}
        </div>
      </div>

      {/* ── Results ── */}
      {shape && shapeResult && (
        <>
          {/* Shape metadata */}
          <div className="card" style={{ marginBottom: 20 }}>
            <div className="card-header">
              <span className="card-title">Shape Result</span>
              <span
                style={{
                  fontSize: 11,
                  fontFamily: 'var(--font-m)',
                  color: 'var(--text-t)',
                }}
              >
                {shapeResult.shapePath}
              </span>
            </div>
            <div className="card-body">
              {/* Run text */}
              <div style={{ marginBottom: 16 }}>
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: '0.05em',
                    color: 'var(--text-t)',
                    marginBottom: 4,
                  }}
                >
                  Run Text
                </div>
                <p style={{ fontSize: 13, color: 'var(--text)', margin: 0 }}>
                  {shapeResult.runText}
                </p>
              </div>

              {/* Classification / type info */}
              {'classification' in shape && (
                <div style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-t)',
                      marginBottom: 4,
                    }}
                  >
                    Classification
                  </div>
                  <span className="badge badge-passed">
                    {String((shape as Record<string, unknown>).classification)}
                  </span>
                </div>
              )}

              {/* Risk level */}
              {'risk' in shape && (
                <div style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-t)',
                      marginBottom: 4,
                    }}
                  >
                    Risk
                  </div>
                  <span className="badge badge-pending">
                    {String((shape as Record<string, unknown>).risk)}
                  </span>
                </div>
              )}

              {/* Acceptance criteria */}
              {'acceptanceCriteria' in shape && Array.isArray((shape as Record<string, unknown>).acceptanceCriteria) && (
                <div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-t)',
                      marginBottom: 6,
                    }}
                  >
                    Acceptance Criteria
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                    {((shape as Record<string, unknown>).acceptanceCriteria as string[]).map(
                      (item, i) => (
                        <li key={i} style={{ marginBottom: 4, color: 'var(--text)' }}>
                          {item}
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              )}

              {/* Non-goals */}
              {'nonGoals' in shape && Array.isArray((shape as Record<string, unknown>).nonGoals) && (
                <div style={{ marginTop: 12 }}>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                      color: 'var(--text-t)',
                      marginBottom: 6,
                    }}
                  >
                    Non-Goals
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 13 }}>
                    {((shape as Record<string, unknown>).nonGoals as string[]).map(
                      (item, i) => (
                        <li key={i} style={{ marginBottom: 4, color: 'var(--text-s)' }}>
                          {item}
                        </li>
                      ),
                    )}
                  </ul>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Empty State ── */}
      {!shapeResult && !shapeMutation.isPending && (
        <div className="card">
          <div className="card-body">
            <p className="text-muted" style={{ textAlign: 'center', padding: '24px 0' }}>
              Enter demand text and click &quot;Evaluate Shape&quot; to analyze
              the demand structure and classification.
            </p>
          </div>
        </div>
      )}
    </>
  );
}
