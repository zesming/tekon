import { useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import {
  useMutation,
  useQuery,
  useSessionToken,
} from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import { queryKeys } from '../../lib/query-keys.js';
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
  const startInFlightRef = useRef(false);

  const {
    data: plan,
    isLoading: planLoading,
    error: planError,
    refetch: refetchPlan,
  } = useQuery<RpcProcedureMap['workflow.plan']['output']>(
    queryKeys.workflowPlan('workflow'),
    () => rpc.call('workflow.plan', { mode: 'workflow' }),
  );

  const startMutation = useMutation<
    RpcProcedureMap['project.run']['input'],
    RpcProcedureMap['project.run']['output']
  >((input) => rpc.call('project.run', input), {
    invalidateKeys: ['session.list', 'project.detail', 'project.overview'],
  });

  const planDigest = plan?.digest;
  const canSend =
    Boolean(token) &&
    text.trim().length > 0 &&
    Boolean(planDigest) &&
    !planLoading &&
    !planError &&
    !startMutation.isPending;

  const handleSend = async () => {
    if (startInFlightRef.current || !canSend || !token || !planDigest) return;

    // React mutation state is asynchronous. Latch synchronously so a second
    // activation in the same event-loop turn cannot create a duplicate Run.
    startInFlightRef.current = true;
    try {
      const result = await startMutation.mutate({
        demandText: text.trim(),
        token,
        planDigest,
      });
      if (result?.sessionId) {
        setText('');
        navigate(routes.session(result.sessionId));
      }
    } catch {
      // Error surfaced via startMutation.error below; nothing else to do.
    } finally {
      startInFlightRef.current = false;
    }
  };

  const humanApprovalCount =
    plan?.gates.filter((gate) => gate.requiresHumanApproval).length ?? 0;

  return (
    <div className="session-composer" aria-busy={startMutation.isPending}>
      <textarea
        className="input session-composer-input"
        aria-label="新建受控交付任务"
        aria-describedby={
          startMutation.error
            ? 'session-composer-hint session-composer-plan session-composer-error'
            : 'session-composer-hint session-composer-plan'
        }
        aria-invalid={Boolean(startMutation.error)}
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
          <div className="text-danger" role="alert">
            执行计划缺少校验摘要，已阻止启动。请重新读取计划后再试。
          </div>
        ) : plan ? (
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>
              执行前计划
            </div>
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
          </div>
        ) : null}
      </div>

      <div className="session-composer-actions">
        <span
          id="session-composer-hint"
          className="text-muted session-composer-hint"
        >
          当前入口会启动 standard-delivery 受控交付全链路；轻量协作、会话内追问与转向尚未开放
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canSend}
          onClick={handleSend}
        >
          {startMutation.isPending ? '正在创建交付…' : '启动受控交付'}
        </button>
      </div>
      {startMutation.error ? (
        <p
          id="session-composer-error"
          className="session-composer-error text-danger"
          role="alert"
        >
          {startMutation.error.message}
        </p>
      ) : null}
    </div>
  );
}
