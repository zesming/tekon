import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router';
import { useMutation, useQuery } from '../../hooks/index.js';
import { useSessionToken } from '../../hooks/use-session-token.js';
import { useFlash } from '../../context/flash-context.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
import { formatTimeout, formatPhaseParallel } from '../../lib/plan-format.js';
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

/** Human-facing labels; experimental and synthetic providers carry caveats inline. */
const AGENT_LABELS: Record<(typeof AGENT_OPTIONS)[number], string> = {
  codex: 'codex',
  'claude-code': 'claude-code',
  mock: 'mock（仅测试/演示 · 生成合成产物，不执行真实任务）',
  'dsh-headless': 'dsh-headless（experimental · 联网不受限 · 仅 Goal）',
};

/**
 * Collapsible "New Run" form with demand, mode, template, agent, execution plan preview,
 * unrestricted network confirmation, and timeout fields.
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
  const [acknowledgedNetwork, setAcknowledgedNetwork] = useState(false);
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

  const parsedTimeout = Number(timeoutMs);
  const validTimeout =
    Number.isFinite(parsedTimeout) && parsedTimeout > 0
      ? parsedTimeout
      : undefined;
  const parsedNoProgress = Number(noProgressTimeoutMs);
  const validNoProgress =
    Number.isFinite(parsedNoProgress) && parsedNoProgress > 0
      ? parsedNoProgress
      : undefined;

  // ── Fetch workflow execution plan preview (T2) ──
  const effectiveTemplate = mode === 'goal' ? undefined : (template || undefined);
  const {
    data: planData,
    isLoading: planLoading,
    error: planError,
    refetch: refetchPlan,
  } = useQuery<RpcProcedureMap['workflow.plan']['output']>(
    queryKeys.workflowPlan(
      mode,
      effectiveTemplate,
      agent,
      mode === 'workflow' ? profile : undefined,
      allowDirtyBase,
      validTimeout,
      validNoProgress,
    ),
    () =>
      rpc.call('workflow.plan', {
        mode,
        template: effectiveTemplate,
        agent,
        profile: mode === 'workflow' ? profile : undefined,
        allowDirtyBase: allowDirtyBase ? true : undefined,
        timeoutMs: validTimeout,
        noProgressTimeoutMs: validNoProgress,
      }),
  );

  // Reset or align network acknowledgement when agent/plan changes
  const requiresUnrestrictedNetwork = Boolean(
    planData?.requiresUnrestrictedNetwork || agent === 'dsh-headless',
  );
  const missingPlanDigest =
    mode === 'workflow' && Boolean(planData) && !planData?.digest;

  useEffect(() => {
    if (!requiresUnrestrictedNetwork) {
      setAcknowledgedNetwork(false);
    }
  }, [requiresUnrestrictedNetwork]);

  // P0-03 (S7c): when a shaped draft is loaded, the server rejects unless it is
  // approved AND readyForRun. Mirror that in the UI so submit is disabled with
  // an explanation instead of surfacing a server 400.
  const draft = demandDetail?.shape;
  const draftNotReady = Boolean(
    shapePath && draft && !(draft.approved && draft.readyForRun),
  );

  // ── Start run mutation ──
  const startMutation = useMutation<
    RpcProcedureMap['project.run']['input'],
    RpcProcedureMap['project.run']['output']
  >((input) => rpc.call('project.run', input), {
    invalidateKeys: ['project.detail', 'project.overview', 'session.list'],
  });

  const handleModeChange = (nextMode: RunMode) => {
    setMode(nextMode);
    if (nextMode === 'goal') {
      setTemplate('');
      setProfile('human-web');
    } else if (agent === 'dsh-headless') {
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
    if (planLoading || !planData || planError) {
      addFlash('warning', '执行计划尚未准备完成，已阻止启动');
      return;
    }
    if (mode === 'workflow' && !planData.digest) {
      addFlash('warning', '执行计划缺少校验摘要，已阻止启动');
      return;
    }
    if (requiresUnrestrictedNetwork && !acknowledgedNetwork) {
      addFlash('warning', '联网不受限需知情确认');
      return;
    }

    const input: RpcProcedureMap['project.run']['input'] = {
      demandText: demandText.trim(),
      token,
    };

    if (shapePath) input.demandShapePath = shapePath;
    if (mode === 'goal') input.mode = 'goal';
    if (mode === 'workflow' && template) input.template = template;
    if (agent) input.agent = agent;
    // B1 fix: profile must be sent unconditionally in workflow mode so the
    // run-submission digest input domain matches the plan-preview domain
    // (which always sends profile). Omitting the default 'human-web' here
    // made the server-computed digest diverge and rejected every default run.
    if (mode === 'workflow') input.profile = profile;
    if (allowDirtyBase) input.allowDirtyBase = true;
    if (requiresUnrestrictedNetwork && acknowledgedNetwork) {
      input.acknowledgeUnrestrictedNetwork = true;
    }
    if (mode !== 'goal' && planData.digest) {
      input.planDigest = planData.digest;
    }

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
      setAcknowledgedNetwork(false);
      setIsOpen(false);
    } catch (err) {
      addFlash(
        'error',
        err instanceof Error ? err.message : '启动运行失败',
      );
    }
  };

  const isSubmitDisabled =
    !token ||
    startMutation.isPending ||
    planLoading ||
    !demandText.trim() ||
    draftNotReady ||
    (requiresUnrestrictedNetwork && !acknowledgedNetwork) ||
    !planData ||
    missingPlanDigest ||
    Boolean(planError);

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
          {agent === 'mock' ? (
            <p
              className="text-sm"
              role="note"
              style={{ color: 'var(--warn, #b45309)', marginTop: 8 }}
            >
              mock 仅用于测试或演示：它会生成合成结果与产物，不会执行真实代理任务，也不能作为交付完成证据。
            </p>
          ) : null}

          {/* Execution Plan Error / Fail-Closed Alert (P1-UX-01) */}
          {planError ? (
            <div
              className="flex items-center gap-2 mb-4"
              role="alert"
              style={{
                background: 'var(--fail-bg, #fef2f2)',
                border: '1px solid #fecaca',
                borderRadius: '8px',
                padding: '12px 14px',
                marginTop: '12px',
              }}
            >
              <span style={{ color: 'var(--fail, #991b1b)', fontSize: '13px' }}>
                无法读取执行计划，已阻止启动：{planError.message}
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={refetchPlan}
              >
                重试
              </button>
            </div>
          ) : planLoading ? (
            <div className="text-muted text-sm my-2">正在读取执行计划…</div>
          ) : missingPlanDigest ? (
            <div
              className="flex items-center gap-2 mb-4"
              role="alert"
              style={{
                background: 'var(--fail-bg, #fef2f2)',
                border: '1px solid #fecaca',
                borderRadius: '8px',
                padding: '12px 14px',
                marginTop: '12px',
              }}
            >
              <span style={{ color: 'var(--fail, #991b1b)', fontSize: '13px' }}>
                执行计划缺少校验摘要，已阻止启动。请重新读取计划后再试。
              </span>
              <button
                type="button"
                className="btn btn-ghost btn-xs"
                onClick={refetchPlan}
              >
                重试
              </button>
            </div>
          ) : planData ? (
            <div
              className="run-plan-preview mb-4"
              role="region"
              aria-label="执行计划预览"
              style={{
                background: 'var(--surface-h)',
                border: '1px solid var(--border)',
                borderRadius: '8px',
                padding: '14px 16px',
                marginTop: '12px',
              }}
            >
              <div
                className="flex items-center justify-between"
                style={{ marginBottom: '10px' }}
              >
                <span
                  style={{
                    fontSize: '13px',
                    fontWeight: 600,
                    color: 'var(--text)',
                  }}
                >
                  📋 执行计划预览
                </span>
                {planData.requiresUnrestrictedNetwork ? (
                  <span className="badge badge-blocked badge-sm">
                    联网不受限
                  </span>
                ) : (
                  <span className="badge badge-paused badge-sm">
                    计划未请求不受限网络
                  </span>
                )}
              </div>

              {!planData.requiresUnrestrictedNetwork ? (
                <p
                  className="text-muted"
                  style={{ fontSize: '11px', marginBottom: '10px' }}
                >
                  此处只表示计划未声明不受限网络；实际网络隔离仍取决于 Provider 与宿主环境。
                </p>
              ) : null}

              {/* Role Chain */}
              <div style={{ marginBottom: '10px' }}>
                <span
                  className="text-sm text-muted"
                  style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}
                >
                  角色链路：
                </span>
                <div className="flex gap-2 items-center" style={{ flexWrap: 'wrap' }}>
                  {planData.roleChain.map((role, idx) => (
                    <span key={role} className="flex items-center gap-2">
                      {idx > 0 && (
                        <span style={{ color: 'var(--text-t)', fontSize: '11px' }}>
                          →
                        </span>
                      )}
                      <span className="badge-tag accent">{role}</span>
                    </span>
                  ))}
                </div>
              </div>

              {/* Phases */}
              {planData.phases && planData.phases.length > 0 && (
                <div style={{ marginBottom: '10px' }}>
                  <span
                    className="text-sm text-muted"
                    style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}
                  >
                    执行阶段：
                  </span>
                  <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                    {planData.phases.map((phase) => (
                      <div
                        key={phase.id}
                        style={{
                          background: 'var(--surface)',
                          border: '1px solid var(--border-l)',
                          borderRadius: '6px',
                          padding: '6px 10px',
                          fontSize: '12px',
                        }}
                      >
                        <div style={{ fontWeight: 600 }}>{phase.name}</div>
                        <div className="text-muted" style={{ fontSize: '11px' }}>
                          {formatPhaseParallel(phase.parallel)} · 节点: {phase.nodeIds.join(', ')}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Gates */}
              {planData.gates && planData.gates.length > 0 && (
                <div>
                  <span
                    className="text-sm text-muted"
                    style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}
                  >
                    Gate 审批与控制点：
                  </span>
                  <div className="flex gap-2" style={{ flexWrap: 'wrap' }}>
                    {planData.gates.map((g) => (
                      <div
                        key={`${g.nodeId}-${g.type}`}
                        style={{
                          background: 'var(--surface)',
                          border: g.requiresHumanApproval
                            ? '1px solid var(--blk)'
                            : '1px solid var(--border-l)',
                          borderRadius: '6px',
                          padding: '6px 10px',
                          fontSize: '12px',
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span style={{ fontWeight: 600 }}>{g.type}</span>
                          <span className="text-muted">({g.role})</span>
                          {g.requiresHumanApproval && (
                            <span className="badge-tag risk">人工审批</span>
                          )}
                        </div>
                        <div className="text-muted" style={{ fontSize: '11px' }}>
                          节点: {g.nodeId} · 超时: {formatTimeout(g.timeoutMs)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : null}

          {/* Unrestricted Network Warning & Checkbox (T2) */}
          {requiresUnrestrictedNetwork && (
            <div
              className="mb-4"
              role="alert"
              style={{
                background: 'var(--fail-bg, #fef2f2)',
                border: '1px solid #fecaca',
                borderRadius: '8px',
                padding: '12px 14px',
              }}
            >
              <div
                style={{
                  fontSize: '13px',
                  color: '#991b1b',
                  marginBottom: '8px',
                  fontWeight: 600,
                }}
              >
                ⚠ 风险提示：当前执行代理（{agent}）联网不受限，运行环境将具备完整网络访问权限。
              </div>
              <label
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  fontSize: '13px',
                  cursor: 'pointer',
                  fontWeight: 600,
                  color: '#991b1b',
                }}
              >
                <input
                  type="checkbox"
                  id="unrestricted-network-ack"
                  checked={acknowledgedNetwork}
                  onChange={(e) => setAcknowledgedNetwork(e.target.checked)}
                />
                我已知悉本次运行联网不受限
              </label>
            </div>
          )}

          {/* Advanced collapsible section */}
          <details
            style={{
              marginBottom: '16px',
              background: 'var(--surface-h)',
              border: '1px solid var(--border-l)',
              borderRadius: '6px',
              padding: '8px 12px',
            }}
          >
            <summary
              style={{
                fontSize: '12px',
                fontWeight: 600,
                color: 'var(--text-s)',
                cursor: 'pointer',
                userSelect: 'none',
              }}
            >
              ⚙ 高级设置（超时与工作区）
            </summary>
            <div
              className="form-row mt-2"
              style={{ gridTemplateColumns: '1fr 1fr 1fr', marginTop: '10px' }}
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
          </details>

          {/* Actions */}
          <div
            className="flex gap-2 items-center"
            style={{ justifyContent: 'flex-end' }}
          >
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={isSubmitDisabled}
              onClick={handleStart}
            >
              {startMutation.isPending ? '⏳ 启动中…' : '▶ 发起运行'}
            </button>
          </div>

          {!token && (
            <p
              className="text-sm"
              style={{ color: 'var(--warn, #b45309)', marginTop: 8 }}
            >
              请先在顶栏配置会话令牌，再发起运行。
            </p>
          )}

          {draftNotReady && (
            <p
              className="text-sm"
              style={{ color: 'var(--warn, #b45309)', marginTop: 8 }}
            >
              该需求草案尚未批准或仍有待澄清问题，需先在草案页批准并清空开放问题后再发起运行。
            </p>
          )}

          {requiresUnrestrictedNetwork && !acknowledgedNetwork && (
            <p
              className="text-sm"
              style={{ color: '#991b1b', marginTop: 8 }}
            >
              需勾选知情确认框后方可发起不受限网络运行。
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
