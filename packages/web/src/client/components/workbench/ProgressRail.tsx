import { Fragment } from 'react';
import { AgentIcon, WbIcons } from './AgentIcon.js';

export interface RailStepItem {
  id: string;
  name: string;
  role: string;
  driver: string;
  model: string;
  effort: string;
  state: 'passed' | 'running' | 'paused' | 'confirm' | 'failed' | 'cancelled' | 'pending';
  durationSec?: string;
  reuseAnchorOrder?: number | null;
}

export function TopDotLineRail({
  steps,
  expanded,
  narrow,
  onToggleExpand,
  onSwitchToRight,
  onSelectNode,
  onInspectNode,
}: {
  steps: RailStepItem[];
  expanded: boolean;
  narrow: boolean;
  onToggleExpand: () => void;
  onSwitchToRight: () => void;
  onSelectNode: (nodeId: string) => void;
  onInspectNode: (nodeId: string) => void;
}) {
  return (
    <section className="wb-top-rail" aria-label="流程进度">
      <div className="wb-dotline-bar">
        <div className="wb-dotline-track">
          {steps.map((s, idx) => {
            const isCurrent =
              s.state === 'running' ||
              s.state === 'paused' ||
              s.state === 'confirm' ||
              s.state === 'failed';
            const next = steps[idx + 1];
            return (
              <Fragment key={s.id}>
                <button
                  type="button"
                  className={`wb-dl-step ${isCurrent ? 'current' : s.state === 'pending' ? 'pending' : ''}`}
                  onClick={() => onSelectNode(s.id)}
                  title={`${s.name} · ${s.role} · ${s.driver}/${s.model}/${s.effort}`}
                >
                  <span className={`wb-node-dot wb-nd-${s.state}`} aria-hidden="true" />
                  <AgentIcon agentId={s.driver} size="sm" />
                  <span>{s.name.slice(0, 6)}</span>
                </button>
                {next ? (
                  <div className={`wb-dl-edge ${s.state === 'passed' ? 'done' : ''}`}>
                    <button
                      type="button"
                      className={`wb-dl-mid-btn ${next.reuseAnchorOrder ? 'reuse' : ''}`}
                      onClick={() => onInspectNode(next.id)}
                      title={
                        next.reuseAnchorOrder
                          ? `查看交接上下文（续接 #${next.reuseAnchorOrder}）`
                          : `查看节点「${next.name}」上下文`
                      }
                      aria-label={`查看节点 ${next.name} 上下文`}
                    />
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
          {!narrow ? (
            <button
              type="button"
              className="wb-icon-btn wb-icon-btn-sm"
              onClick={onSwitchToRight}
              title="切换为右侧竖向进度轨"
              aria-label="切换为右侧竖向进度轨"
            >
              {WbIcons.railSlim}
            </button>
          ) : null}
          <button
            type="button"
            className="wb-icon-btn wb-icon-btn-sm"
            onClick={onToggleExpand}
            title={expanded ? '收起为点线' : '展开节点详情'}
            aria-label={expanded ? '收起为点线' : '展开节点详情'}
          >
            {expanded ? WbIcons.chevUp : WbIcons.chevDown}
          </button>
        </div>
      </div>
      {expanded ? (
        <div className="wb-rail-expanded">
          {steps.map((s, i) => (
            <button
              key={s.id}
              type="button"
              className={`wb-rx-card st-${s.state}`}
              onClick={() => onSelectNode(s.id)}
            >
              <div className="wb-rx-top">
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <AgentIcon agentId={s.driver} size="sm" />
                  {i + 1}. {s.name}
                </span>
                <span className="wb-mono" style={{ color: 'var(--text-t)' }}>
                  {s.durationSec ?? ''}
                </span>
              </div>
              <div className="wb-rx-sub">
                {s.role} · {s.driver}/{s.model}/{s.effort}
                {s.reuseAnchorOrder ? ` · ↻#${s.reuseAnchorOrder}` : ''}
              </div>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

export function RightVerticalRail({
  steps,
  slim,
  onToggleSlim,
  onSwitchToTop,
  onSelectNode,
  onInspectNode,
}: {
  steps: RailStepItem[];
  slim: boolean;
  onToggleSlim: () => void;
  onSwitchToTop: () => void;
  onSelectNode: (nodeId: string) => void;
  onInspectNode: (nodeId: string) => void;
}) {
  const doneCount = steps.filter((s) => s.state === 'passed').length;
  return (
    <aside className={`wb-v-rail ${slim ? 'slim' : ''}`} aria-label="流程进度">
      <div className="wb-vr-head">
        <span className="wb-vr-head-title">
          已完成 {doneCount}/{steps.length}
        </span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
          {!slim ? (
            <button
              type="button"
              className="wb-icon-btn wb-icon-btn-sm"
              onClick={onSwitchToTop}
              title="切换为顶部点线进度"
              aria-label="切换为顶部点线进度"
            >
              {WbIcons.railTop}
            </button>
          ) : null}
          <button
            type="button"
            className="wb-icon-btn wb-icon-btn-sm"
            onClick={onToggleSlim}
            title={slim ? '展开竖向进度' : '收起为极窄点栏'}
            aria-label="切换右侧进度宽度"
          >
            {WbIcons.railSlim}
          </button>
        </div>
      </div>
      <div className="wb-vr-list">
        {steps.map((s, idx) => {
          const isCurrent =
            s.state === 'running' ||
            s.state === 'paused' ||
            s.state === 'confirm' ||
            s.state === 'failed';
          const next = steps[idx + 1];
          return (
            <Fragment key={s.id}>
              <button
                type="button"
                className={`wb-vr-step ${isCurrent ? 'current' : s.state === 'pending' ? 'pending' : ''}`}
                onClick={() => onSelectNode(s.id)}
                title={`${s.name} · ${s.role} · ${s.driver}/${s.model}/${s.effort}`}
                aria-label={`${s.name}（${s.role} · ${s.model}）`}
              >
                <span
                  className={`wb-node-dot wb-nd-${s.state}`}
                  style={{ marginTop: slim ? 0 : 4 }}
                  aria-hidden="true"
                />
                <div className="wb-vr-info">
                  <div className="wb-vr-name">{s.name}</div>
                  <div className="wb-vr-meta">
                    <AgentIcon agentId={s.driver} size="sm" />
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.role} · {s.model}/{s.effort}
                    </span>
                  </div>
                </div>
              </button>
              {next ? (
                <div className={`wb-vr-edge ${s.state === 'passed' ? 'done' : ''}`}>
                  <button
                    type="button"
                    className={`wb-vr-edge-btn ${next.reuseAnchorOrder ? 'reuse' : ''}`}
                    onClick={() => onInspectNode(next.id)}
                    title={
                      next.reuseAnchorOrder
                        ? `查看交接上下文（续接 #${next.reuseAnchorOrder}）`
                        : `查看节点「${next.name}」上下文`
                    }
                    aria-label={`查看节点 ${next.name} 上下文`}
                  >
                    {next.reuseAnchorOrder ? (
                      <>
                        {WbIcons.reuse}
                        <span> #{next.reuseAnchorOrder}</span>
                      </>
                    ) : (
                      WbIcons.ctx
                    )}
                  </button>
                </div>
              ) : null}
            </Fragment>
          );
        })}
      </div>
    </aside>
  );
}
