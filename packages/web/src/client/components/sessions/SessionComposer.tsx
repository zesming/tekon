import { useState } from 'react';
import { useNavigate } from 'react-router';

import { useMutation, useSessionToken } from '../../hooks/index.js';
import { rpc } from '../../lib/rpc-client.js';
import { routes } from '../../lib/route-paths.js';
import type { RpcProcedureMap } from '../../../shared/rpc-contract.js';

// Phase 3 3b: composer for starting a new session-backed run.
//
// D5: this does NOT inject run-time messages (follow-up/steer) — that needs
// AgentHandle.followUp/steer, deferred to phase 2b (throws NotSupportedYet).
// The composer starts a new run; run-time control (pause/cancel/resume) lives
// in the right rail (3c). On success it captures the returned sessionId (which
// the old StartRunForm dropped) and navigates to the new session.

export function SessionComposer() {
  const { token } = useSessionToken();
  const navigate = useNavigate();
  const [text, setText] = useState('');

  const startMutation = useMutation<
    RpcProcedureMap['project.run']['input'],
    RpcProcedureMap['project.run']['output']
  >((input) => rpc.call('project.run', input), {
    invalidateKeys: ['session.list', 'project.detail', 'project.overview'],
  });

  const canSend =
    Boolean(token) && text.trim().length > 0 && !startMutation.isPending;

  const handleSend = async () => {
    if (!canSend || !token) return;
    try {
      const result = await startMutation.mutate({
        demandText: text.trim(),
        token,
      });
      // Capture the sessionId the server returns (3a) and open the session.
      if (result?.sessionId) {
        setText('');
        navigate(routes.session(result.sessionId));
      }
    } catch {
      // Error surfaced via startMutation.error below; nothing else to do.
    }
  };

  return (
    <div className="session-composer">
      <textarea
        className="input session-composer-input"
        aria-label="新建受控交付任务"
        placeholder={
          token
            ? '描述需要受控交付的需求（将运行 PM / RD / QA / Reviewer 全链路）…'
            : '请先在顶栏设置会话令牌'
        }
        value={text}
        disabled={!token}
        onChange={(e) => setText(e.target.value)}
        rows={3}
      />
      <div className="session-composer-actions">
        <span className="text-muted session-composer-hint">
          当前入口会启动 standard-delivery 受控交付全链路；轻量协作、会话内追问与转向尚未开放
        </span>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          disabled={!canSend}
          onClick={handleSend}
        >
          {startMutation.isPending ? '启动中…' : '开始会话'}
        </button>
      </div>
      {startMutation.error ? (
        <p className="session-composer-error text-danger">
          {startMutation.error.message}
        </p>
      ) : null}
    </div>
  );
}
