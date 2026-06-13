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
    RpcProcedureMap['demand.detail']['output']
  >(
    shapePath && token ? `demand.detail:${shapePath}` : null,
    () => rpc.call('demand.detail', { shapePath, token: token! }),
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
      addFlash('warning', 'Please set your session token first');
      return;
    }
    if (!demandText.trim()) {
      addFlash('warning', 'Please enter a demand description');
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
        `Run started: ${result.run.id.slice(0, 12)}`,
      );
      setDemandText('');
      setIsOpen(false);
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : 'Failed to start run',
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
        <span className="card-title">✦ 新建运行 New Run</span>
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
            <label className="form-label">需求描述 Demand</label>
            <textarea
              className="textarea"
              aria-label="描述你的需求"
              value={demandText}
              onChange={(e) => setDemandText(e.target.value)}
              placeholder="Describe what you need…"
            />
          </div>

          {/* Template + Agent row */}
          <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="form-group">
              <label className="form-label">
                工作流模板 Workflow Template
              </label>
              <select
                className="select"
                value={template}
                onChange={(e) => setTemplate(e.target.value)}
              >
                <option value="">— Default —</option>
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Agent</label>
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
              <label className="form-label">超时 Timeout (ms)</label>
              <input
                className="input"
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label className="form-label">
                无进展超时 No-Progress Timeout (ms)
              </label>
              <input
                className="input"
                type="number"
                value={noProgressTimeoutMs}
                onChange={(e) => setNoProgressTimeoutMs(e.target.value)}
                placeholder="optional"
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
                Allow dirty base
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
              {startMutation.isPending ? '⏳ Starting…' : '▶ 发起运行 Start Run'}
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
