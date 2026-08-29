import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery } from '../../hooks/index.js';
import { useSessionToken } from '../../hooks/use-session-token.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface StartRunFormProps {
  /** When true, the form starts expanded; default collapsed. */
  defaultOpen?: boolean;
}

type RunMode = 'workflow' | 'goal';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

const AGENT_OPTIONS = ['codex', 'claude-code', 'mock', 'dsh-headless'] as const;

/** Human-facing labels; dsh-headless carries its experimental caveat inline. */
const AGENT_LABELS: Record<(typeof AGENT_OPTIONS)[number], string> = {
  codex: 'codex',
  'claude-code': 'claude-code',
  mock: 'mock',
  'dsh-headless': 'dsh-headless（experimental · 联网不受限 · 仅 Goal）',
};

/**
 * Collapsible "New Run" form with demand, mode, template, agent, and timeout
 * fields. Goal is explicit because dsh-headless cannot satisfy governed
 * workflow artifact contracts.
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
    shapePath && token ? queryKeys.draftShapeDetail(shapePath) : null,
    () => rpc.call('draftShape.detail', { shapePath, token: token! }),
  );

  // ── Local form state ──
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [demandText, setDemandText] = useState('');
  const [mode, setMode] = useState<RunMode>('workflow');
  const [template, setTemplate] = useState('');
  const [agent, setAgent] = useState<string>(AGENT_OPTIONS[0]);
  const [profile, setProfile] = useState<'human-web' | 'autonomous-delivery'>(
    'human-web',
  );
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
  >(queryKeys.workflows(), () => rpc.call('workflow.list'));

  const workflows = workflowData?.workflows ?? [];

  // P0-03 (S7c): when a shaped draft is loaded, the server rejects unless it is
  // approved AND readyForRun. Mirror that in the UI so submit is disabled with
  // an explanation instead of surfacing a server 400 (UI guidance, not the
  // security boundary — the server file check is authoritative).
  const draft = demandDetail?.shape;
  const draftNotReady = Boolean(
    shapePath && draft && !(draft.approved && draft.readyForRun),
  );

  // ── Start run mutation ──
  const startMutation = useMutation<
    RpcProcedureMap['project.run']['input'],
    RpcProcedureMap['project.run']['output']
  >((input) => rpc.call('project.run', input), {
    invalidateKeys: ['project.detail', 'project.overview'],
  });

  const handleModeChange = (nextMode: RunMode) => {
    setMode(nextMode);
    if (nextMode === 'goal') {
      setTemplate('');
      setProfile('human-web');
    } else if (agent === 'dsh-headless') {
      // dsh-headless is an official one-shot profile and cannot produce the
      // artifact/gate contract of a governed workflow.
      setAgent('codex');
    }
  };

  const handleAgentChange = (nextAgent: string) => {
    setAgent(nextAgent);
    if (nextAgent === 'dsh-headless') {
      setMode('goal');
      setTemplate('');
      setProfile('human-web');
    }
  };

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

    // P0-03 (S7c): forward the shaped-draft path so the server enforces
    // approved + readyForRun against the file (not a client boolean). Without
    // this the client silently dropped the path and ran as free text.
    if (shapePath) input.demandShapePath = shapePath;

    if (mode === 'goal') input.mode = 'goal';
    if (mode === 'workflow' && template) input.template = template;
    if (agent) input.agent = agent;
    if (mode === 'workflow' && profile !== 'human-web') input.profile = profile;
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
      addFlash('success', `运行已启动: ${result.run.id.slice(0, 12)}`);
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
      <button
        type="button"
        className="card-header"
        aria-expanded={isOpen}
        aria-controls="start-run-form-body"
        onClick={() => setIsOpen((prev) => !prev)}
        style={{
          width: '100%',
          background: 'transparent',
          color: 'inherit',
          borderTop: 0,
          borderRight: 0,
          borderLeft: 0,
          textAlign: 'left',
        }}
      >
        <span className="card-title">✦ 新建运行</span>
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden="true"
          focusable="false"
          style={{
            transform: isOpen ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.2s',
          }}
        >
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>

      {isOpen && (
        <div id="start-run-form-body" className="card-body">
          {/* Demand */}
          <div className="form-group">
            <label className="form-label" htmlFor="start-run-demand">
              需求描述
            </label>
            <textarea
              id="start-run-demand"
              className="textarea"
              value={demandText}
              onChange={(e) => setDemandText(e.target.value)}
              placeholder="描述你的需求…"
            />
          </div>

          {/* Mode + Template + Agent + Profile */}
          <div className="form-row" style={{ gridTemplateColumns: '1fr 1fr' }}>
            <div className="form-group">
              <label className="form-label" htmlFor="start-run-mode">
                运行模式
              </label>
              <select
                id="start-run-mode"
                className="select"
                value={mode}
                aria-describedby="run-mode-help"
                onChange={(e) => handleModeChange(e.target.value as RunMode)}
              >
                <option value="workflow">受控交付（Workflow）</option>
                <option value="goal">一次性任务（Goal）</option>
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="start-run-template">
                工作流模板
              </label>
              <select
                id="start-run-template"
                className="select"
                value={template}
                disabled={mode === 'goal'}
                onChange={(e) => setTemplate(e.target.value)}
              >
                <option value="">
                  {mode === 'goal' ? '— Goal 不使用模板 —' : '— 默认 —'}
                </option>
                {workflows.map((wf) => (
                  <option key={wf.id} value={wf.id}>
                    {wf.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="start-run-agent">
                执行代理
              </label>
              <select
                id="start-run-agent"
                className="select"
                value={agent}
                aria-describedby="run-mode-help"
                onChange={(e) => handleAgentChange(e.target.value)}
              >
                {AGENT_OPTIONS.map((a) => (
                  <option key={a} value={a}>
                    {AGENT_LABELS[a]}
                  </option>
                ))}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label" htmlFor="start-run-profile">
                Profile
              </label>
              <select
                id="start-run-profile"
                className="select"
                value={profile}
                disabled={mode === 'goal'}
                onChange={(e) =>
                  setProfile(
                    e.target.value as 'human-web' | 'autonomous-delivery',
                  )
                }
              >
                <option value="human-web">human-web（默认）</option>
                <option value="autonomous-delivery">
                  autonomous-delivery（通过后自动准备交付，不自动创建 PR）
                </option>
              </select>
            </div>
          </div>
          <p id="run-mode-help" className="text-sm text-muted">
            {mode === 'goal'
              ? 'Goal 是单节点一次性任务，不进入 Gate、Artifact 或交付链路。dsh-headless 仅可在此模式使用，且网络访问不受 Tekon 限制。'
              : '受控交付会执行模板中的角色、Artifact 与 Gate；dsh-headless 不支持此模式。'}
          </p>

          {/* Timeout row */}
          <div
            className="form-row"
            style={{ gridTemplateColumns: '1fr 1fr 1fr' }}
          >
            <div className="form-group">
              <label className="form-label" htmlFor="start-run-timeout">
                超时 (ms)
              </label>
              <input
                id="start-run-timeout"
                className="input"
                type="number"
                value={timeoutMs}
                onChange={(e) => setTimeoutMs(e.target.value)}
              />
            </div>
            <div className="form-group">
              <label
                className="form-label"
                htmlFor="start-run-no-progress-timeout"
              >
                无进展超时 (ms)
              </label>
              <input
                id="start-run-no-progress-timeout"
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
              disabled={
                startMutation.isPending || !demandText.trim() || draftNotReady
              }
              onClick={handleStart}
            >
              {startMutation.isPending ? '⏳ 启动中…' : '▶ 发起运行'}
            </button>
          </div>

          {draftNotReady && (
            <p
              className="text-sm"
              style={{ color: 'var(--warn, #b45309)', marginTop: 8 }}
            >
              该需求草案尚未批准或仍有待澄清问题，需先在草案页批准并清空开放问题后再发起运行。
            </p>
          )}

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
