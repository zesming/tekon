import { useState } from 'react';

import { useMutation, useSessionToken } from '../../hooks/index.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ShapeOutput = RpcProcedureMap['draftShape.shape']['output'];

// ---------------------------------------------------------------------------
// DemandShapeTab
// ---------------------------------------------------------------------------

/**
 * DemandShapeTab — evaluate demand shape/structure.
 *
 * Uses the `draftShape.shape` procedure to analyze and classify a demand,
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
    RpcProcedureMap['draftShape.shape']['input'],
    RpcProcedureMap['draftShape.shape']['output']
  >((input) => rpc.call('draftShape.shape', input));

  const handleEvaluate = async () => {
    if (!token) {
      addFlash('warning', '请先设置会话令牌');
      return;
    }
    if (!demandText.trim()) {
      addFlash('warning', '请输入需求描述');
      return;
    }

    try {
      const result = await shapeMutation.mutate({ demandText: demandText.trim(), token });
      setShapeResult(result);
      addFlash('success', '需求分析完成');
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : '需求分析失败',
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
            需求描述
          </label>
          <textarea
            id="demand-shape-text"
            className="input"
            rows={4}
            placeholder="输入需求描述以分析其结构和风险…"
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
              {shapeMutation.isPending ? '分析中…' : '分析需求'}
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
              <span className="card-title">分析结果</span>
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
                  运行文本
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
                    分类
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
                    风险
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
                    验收标准
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
                    非目标
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
              输入需求描述并点击"分析需求"来分析需求结构和分类
              
            </p>
          </div>
        </div>
      )}
    </>
  );
}
