import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery } from '../../hooks/index.js';
import { useSessionToken } from '../../hooks/use-session-token.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartRunFormProps {
  /** When true, the form starts expanded; default collapsed. */
  defaultOpen?: boolean;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const AGENT_OPTIONS = ['codex', 'claude-code', 'mock'] as const;

/**
 * Collapsible "New Run" form with demand, template, agent, timeout fields.
 */
export function StartRunForm({ defaultOpen = false }: StartRunFormProps) {
  const { token } = useSessionToken();
  const { addFlash } = useFlash();
  const [searchParams] = useSearchParams();
  const shapePath = searchParams.get('shapePath') ?? '';

  // ── Fetch demand detail when shapePath is provided ──
  const { data: demandDetail } = useQuery<
    RpcProcedureMap['draftShape.detail']['output']
  >(
    shapePath && token ? `draftShape.detail:${shapePath}` : null,
    () => rpc.call('draftShape.detail', { shapePath, token: token! }),
  );

  // ── Local form state ──
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [demandText, setDemandText] = useState('');
  const [template, setTemplate] = useState('');
  const [agent, setAgent] = useState<string>(AGENT_OPTIONS[0]);
  const [timeoutMs, setTimeoutMs] = useState('3600000');
  const [noProgressTimeoutMs, setNoProgressTimeoutMs] = useState('');
  const [allowDirtyBase, setAllowDirtyBase] = useState(false);

  // ── Prefill from demand detail or URL params ──
  useEffect(() => {
    if (demandDetail?.shape) {
      setDemandText(demandDetail.shape.rawText ?? '');
      setTemplate(demandDetail.shape.recommendedTemplate ?? '');
      setIsOpen(true);
    }
  }, [demandDetail]);

  // ── Fetch workflow templates ──
  const { data: workflowData } = useQuery<
    RpcProcedureMap['workflow.list']['output']
  >('workflow.list', () => rpc.call('workflow.list'));

  const workflows = workflowData?.workflows ?? [];

  // ── Start run mutation ──
  const startMutation = useMutation<
    RpcProcedureMap['project.run']['input'],
    RpcProcedureMap['project.run']['output']
  >(
    (input) => rpc.call('project.run', input),
    { invalidateKeys: ['project.detail', 'project.overview'] },
  );

  const handleStart = async () => {
    if (!token) {
      addFlash('warning', '请先设置会话令牌');
      return;
    }
    if (!demandText.trim()) {
      addFlash('warning', '请输入需求描述');
      return;
    }

    const input: RpcProcedureMap['project.run']['input'] = {
      demandText: demandText.trim(),
      token,
    };

    if (template) input.template = template;
    if (agent) input.agent = agent;
    if (allowDirtyBase) input.allowDirtyBase = true;

    const parsedTimeout = Number(timeoutMs);
    if (Number.isFinite(parsedTimeout) && parsedTimeout > 0) {
      input.timeoutMs = parsedTimeout;
    }

    const parsedNoProgress = Number(noProgressTimeoutMs);
    if (Number.isFinite(parsedNoProgress) && parsedNoProgress > 0) {
      input.noProgressTimeoutMs = parsedNoProgress;
    }

    try {
      const result = await startMutation.mutate(input);
      addFlash(
        'success',
        `运行已启动: ${result.run.id.slice(0, 12)}`,
      );
      setDemandText('');
      setIsOpen(false);
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : '启动运行失败',
      );
    }
  };

  return (
    <div className="card mb-6">
      <div
        className="card-header"
        style={{ cursor: 'pointer' }}
        onClick={() => setIsOpen((prev) => !prev)}
      >
        <span className="card-title">✦ 新建运行</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
          }}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </div>

      {isOpen && (
        <div className="card-body">
          {/* Demand */}
          <div className="form-group">
            <label className="form-label">需求描述</label>
            <textarea
              className="textarea"
              aria-label="描述你的需求"
              value={demandText}
              onChange={(e) => setDemandText(e.target.value)}
              placeholder="描述你的需求…"
            />
          </div>

          {/* Template + Agent row */}
          <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="form-group">
              <label className="form-label">
                工作流模板
              </label>
              <select
                className="select"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
              >
                <option value="">— 默认 —</option>
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">执行代理</label>
              <select
                className="select"
                value={agent}
                onChange={(e) => setAgent(e.target.value)}
              >
                {AGENT_OPTIONS.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Timeout row */}
          <div
            className="form-row"
            style={{ gridTemplateColumns: '1fr 1fr 1fr' }}
          >
            <div className="form-group">
              <label className="form-label">超时 (ms)</label>
              <input
                className="input"
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">
                无进展超时 (ms)
              </label>
              <input
                className="input"
                type="number"
                value={noProgressTimeoutMs}
                onChange={(e) => setNoProgressTimeoutMs(e.target.value)}
                placeholder="可选"
              />
            </div>
            <div className="form-group">
              <label className="form-label" style={{ visibility: 'hidden' }}>
                placeholder
              </label>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  fontSize: 12,
                  cursor: 'pointer',
                  color: 'var(--text-s)',
                  paddingTop: 8,
                }}
              >
                <input
                  type="checkbox"
                  checked={allowDirtyBase}
                  onChange={(e) => setAllowDirtyBase(e.target.checked)}
                />
                允许脏工作区
              </label>
            </div>
          </div>

          {/* Actions */}
          <div
            className="flex gap-2 items-center"
            style={{ justifyContent: 'flex-end' }}
          >
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={startMutation.isPending || !demandText.trim()}
              onClick={handleStart}
            >
              {startMutation.isPending ? '⏳ 启动中…' : '▶ 发起运行'}
            </button>
          </div>

          {startMutation.error && (
            <p
              className="text-sm"
              style={{ color: 'var(--fail)', marginTop: 8 }}
            >
              {startMutation.error.message}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
