import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useQuery, useSessionToken } from '../../hooks/index.js';
import { useRunAdmission } from '../../hooks/use-run-admission.js';
import { AdmissionNotice } from '../runs/AdmissionNotice.js';
import { PlanCommandBindings } from '../runs/PlanCommandBindings.js';
import { usePlanCommandComparison } from '../../hooks/use-plan-command-comparison.js';
import { rpc } from '../../lib/rpc-client.js';
import { authScope, queryKeys } from '../../lib/query-keys.js';
import { routes } from '../../lib/route-paths.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// Phase 3 3b: composer for starting a new session-backed run.
//
// D5: this does NOT inject run-time messages (follow-up/steer) — that needs
// AgentHandle.followUp/steer, deferred to phase 2b (throws NotSupportedYet).
// The composer starts a new run; run-time control (pause/cancel/resume) lives
// in the right rail. The human-first path now loads the same server-derived
// workflow plan as the advanced form before enabling the launch action.

export function SessionComposer() {
  const { token } = useSessionToken();
  const navigate = useNavigate();
  const [text, setText] = useState('');

  const {
    data: plan,
    isLoading: planLoading,
    error: planError,
    refetch: refetchPlan,
  } = useQuery<RpcProcedureMap['workflow.plan']['output']>(
    queryKeys.workflowPlan('workflow'),
    () => rpc.call('workflow.plan', { mode: 'workflow' }),
  );
  const planComparison = usePlanCommandComparison(
    JSON.stringify([authScope(token), queryKeys.workflowPlan('workflow')]),
    plan,
    !planLoading && !planError,
  );

  const admission = useRunAdmission({
    token,
    payload: { demandText: text.trim(), planDigest: plan?.digest },
    onAccepted: async (result) => {
      if (result.sessionId) {
        // 成功离开首页会卸载表单；不让旧导航的 continuation 清空后来输入。
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
            ? '描述需要受控交付的需求（将运行 PM / RD / QA / Reviewer 全链路）…'
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
          当前入口会启动 standard-delivery
          受控交付全链路；轻量协作、会话内追问与转向尚未开放
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
