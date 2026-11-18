import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useQuery, useSessionToken } from '../../hooks/index.js';
import { useRunAdmission } from '../../hooks/use-run-admission.js';
import {
  AGENT_LABELS,
  AGENT_OPTIONS,
  useRunPlanSelection,
} from '../../hooks/use-run-plan-selection.js';
import { AdmissionNotice } from '../runs/AdmissionNotice.js';
import { PlanCommandBindings } from '../runs/PlanCommandBindings.js';
import { usePlanCommandComparison } from '../../hooks/use-plan-command-comparison.js';
import { rpc } from '../../lib/rpc-client.js';
import { authScope } from '../../lib/query-keys.js';
import { routes } from '../../lib/route-paths.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// Phase 3 3b: composer for starting a new session-backed run.
//
// PD-08：首页现在可选择运行模式（受控交付/Goal）、工作流模板与执行代理，
// 计划预览随选择刷新；不再固定 standard-delivery。模板留空时由服务端回落
// 轻量默认 lightweight-delivery，standard-delivery 改为在下拉中显式选择。
// 本组件不注入 run-time 消息（follow-up/steer 仍不支持）。

export function SessionComposer() {
  const { token } = useSessionToken();
  const navigate = useNavigate();
  const [text, setText] = useState('');

  const {
    mode,
    setMode,
    template,
    setTemplate,
    agent,
    setAgent,
    workflows,
    effectiveTemplate,
    planKey,
  } = useRunPlanSelection(token);

  const {
    data: plan,
    isLoading: planLoading,
    error: planError,
    refetch: refetchPlan,
  } = useQuery<RpcProcedureMap['workflow.plan']['output']>(planKey, () =>
    rpc.call('workflow.plan', {
      mode,
      template: effectiveTemplate,
      // 留空时服务端解析同一配置默认（PD-24）。
      ...(agent ? { agent } : {}),
      ...(mode === 'workflow' ? { profile: 'human-web' as const } : {}),
    }),
  );
  const planComparison = usePlanCommandComparison(
    JSON.stringify([authScope(token), planKey]),
    plan,
    !planLoading && !planError,
  );

  const admission = useRunAdmission({
    token,
    payload: {
      demandText: text.trim(),
      planDigest: plan?.digest,
      ...(mode === 'goal' ? { mode: 'goal' as const } : {}),
      ...(mode === 'workflow' && template ? { template } : {}),
      ...(agent ? { agent } : {}),
    },
    onAccepted: async (result) => {
      if (result.sessionId) {
        await navigate(routes.session(result.sessionId));
      }
    },
  });

  const planDigest = plan?.digest;
  const canSend =
    Boolean(token) &&
    text.trim().length > 0 &&
    Boolean(planDigest) &&
    !planLoading &&
    !planError &&
    !admission.isPending &&
    !admission.planExpired &&
    admission.scopeReady;

  const handleSend = async () => {
    if (!canSend) return;
    await admission.submit();
  };

  const humanApprovalCount =
    plan?.gates.filter((gate) => gate.requiresHumanApproval).length ?? 0;

  return (
    <div className="session-composer" aria-busy={admission.isPending}>
      <div className="session-composer-controls form-row start-run-options">
        <div className="form-group">
          <label className="form-label" htmlFor="composer-mode">
            运行模式
          </label>
          <select
            id="composer-mode"
            className="select"
            value={mode}
            onChange={(e) => setMode(e.target.value as 'workflow' | 'goal')}
          >
            <option value="workflow">受控交付（Workflow）</option>
            <option value="goal">一次性任务（Goal）</option>
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="composer-template">
            工作流模板
          </label>
          <select
            id="composer-template"
            className="select"
            value={template}
            disabled={mode === 'goal'}
            onChange={(e) => setTemplate(e.target.value)}
          >
            <option value="">
              {mode === 'goal' ? '— Goal 不使用模板 —' : '— 默认（轻量）—'}
            </option>
            {workflows.map((wf) => (
              <option key={wf.id} value={wf.id}>
                {wf.name}
              </option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label className="form-label" htmlFor="composer-agent">
            执行代理
          </label>
          <select
            id="composer-agent"
            className="select"
            value={agent}
            onChange={(e) => setAgent(e.target.value)}
          >
            {agent === '' && (
              <option value="" disabled>
                加载默认代理…
              </option>
            )}
            {AGENT_OPTIONS.map((a) => (
              <option key={a} value={a}>
                {AGENT_LABELS[a]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <textarea
        className="input session-composer-input"
        aria-label="新建受控交付任务"
        aria-describedby={
          admission.error
            ? 'session-composer-hint session-composer-plan session-composer-error'
            : 'session-composer-hint session-composer-plan'
        }
        aria-invalid={Boolean(admission.error)}
        placeholder={
          token
            ? '描述你的需求…默认走轻量 plan→实现→人工确认，可在上方切换模板/代理'
            : '请先在顶栏设置连接凭据'
        }
        value={text}
        disabled={!token}
        onChange={(e) => setText(e.target.value)}
        rows={3}
      />

      <div
        id="session-composer-plan"
        className="session-composer-plan"
        role="region"
        aria-label="执行前计划"
        style={{
          border: '1px solid var(--border-l)',
          borderRadius: 6,
          padding: '10px 12px',
          background: 'var(--surface-h)',
        }}
      >
        {planLoading ? (
          <span className="text-muted">正在读取执行计划…</span>
        ) : planError ? (
          <div className="flex items-center gap-2" role="alert">
            <span className="text-danger">
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
        ) : plan && !planDigest ? (
          <div className="flex items-center gap-2" role="alert">
            <span className="text-danger">
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
        ) : plan ? (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>执行前计划</div>
            <div className="text-muted" style={{ fontSize: 12 }}>
              执行链路：{plan.roleChain.join(' → ') || '默认角色链'}；
              {plan.gates.length} 个控制点
              {humanApprovalCount > 0
                ? `，其中 ${humanApprovalCount} 个需要人工确认`
                : '，无需预设人工确认'}
              ；
              {plan.requiresUnrestrictedNetwork
                ? '该 Provider 需要不受限网络访问，启动前仍需明确确认'
                : '计划未请求不受限网络；实际隔离取决于 Provider 与宿主环境'}
              。
            </div>
            <PlanCommandBindings plan={plan} comparison={planComparison} onRefresh={refetchPlan} />
          </div>
        ) : null}
      </div>

      <div className="session-composer-actions">
        <span
          id="session-composer-hint"
          className="text-muted session-composer-hint"
        >
          默认轻量模板；需要完整评审/QA 全链路请在上方显式选择 standard-delivery
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canSend}
          onClick={handleSend}
        >
          {admission.isPending ? '正在创建交付…' : '启动受控交付'}
        </button>
      </div>
      {token ? (
        <AdmissionNotice
          admission={admission}
          refetchPlan={refetchPlan}
          errorId="session-composer-error"
        />
      ) : null}
    </div>
  );
}
