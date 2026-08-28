import { useMemo, useState } from 'react';

import { CodeBlock } from '../ui/CodeBlock.js';
import { groupEventsByTurn, type FeedRow } from '../../lib/event-feed.js';
import type { StreamEvent } from '../../lib/session-stream.js';

// Phase 3 3b: renders the session event stream as a continuous narrative.
// The event→row mapping and turn grouping live in lib/event-feed.ts (pure,
// unit-tested); this component is presentation only.

const KIND_LABEL: Record<FeedRow['kind'], string> = {
  message: '',
  tool: '工具',
  step: '步骤',
  turn: '回合',
  governance: '治理',
  error: '错误',
  generic: '事件',
};

/**
 * Default Session view is a product narrative, not a second audit log.
 * Everything remains available behind the explicit technical-events toggle.
 */
function isNarrativeRow(row: FeedRow): boolean {
  if (row.kind === 'message' || row.kind === 'error') return true;
  return (
    row.type === 'workflow/started' ||
    row.type === 'agent/status' ||
    row.type === 'agent/cancel-requested' ||
    row.type === 'agent/cancelled' ||
    row.type === 'agent/steered' ||
    row.type === 'approval/requested' ||
    row.type === 'approval/decided' ||
    row.type === 'readiness/evaluated' ||
    row.type === 'delivery/prepared'
  );
}

function FeedRowView({ row }: { row: FeedRow }) {
  return (
    <div className={`feed-row feed-row-${row.kind}`} data-event-type={row.type}>
      <div className="feed-row-head">
        {row.kind === 'message' ? (
          <span className={`feed-author feed-author-${row.author}`}>
            {row.title}
          </span>
        ) : (
          <span className="feed-kind">{KIND_LABEL[row.kind]}</span>
        )}
        <span className="feed-title">
          {row.kind === 'message' ? '' : row.title}
        </span>
        {row.synthetic ? (
          <span className="feed-tag" title="由产物元数据合成，非模型原文">
            摘要
          </span>
        ) : null}
        {row.truncated ? (
          <span
            className="feed-tag feed-tag-warn"
            title="服务端已截断（spill 递延 2b）"
          >
            已截断
          </span>
        ) : null}
      </div>
      {row.body ? (
        row.kind === 'message' ? (
          <div className="feed-message-body">{row.body}</div>
        ) : (
          <CodeBlock content={row.body} truncated />
        )
      ) : null}
    </div>
  );
}

export function EventFeed({ events }: { events: StreamEvent[] }) {
  const [showTechnical, setShowTechnical] = useState(false);
  const allGroups = useMemo(() => groupEventsByTurn(events), [events]);
  const hiddenTechnicalCount = useMemo(
    () =>
      allGroups.reduce(
        (count, group) =>
          count + group.rows.filter((row) => !isNarrativeRow(row)).length,
        0,
      ),
    [allGroups],
  );
  const groups = useMemo(
    () =>
      allGroups
        .map((group) => ({
          ...group,
          rows: showTechnical
            ? group.rows
            : group.rows.filter(isNarrativeRow),
        }))
        .filter((group) => group.rows.length > 0),
    [allGroups, showTechnical],
  );

  if (events.length === 0) {
    return (
      <div className="feed-empty text-muted" role="status" aria-live="polite">
        等待事件… Waiting for session events.
      </div>
    );
  }

  return (
    <div className="event-feed-shell">
      {hiddenTechnicalCount > 0 ? (
        <div className="event-feed-toolbar">
          <span className="text-muted">
            {showTechnical
              ? '正在显示完整技术时间线'
              : `已隐藏 ${hiddenTechnicalCount} 条技术事件`}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-pressed={showTechnical}
            onClick={() => setShowTechnical((value) => !value)}
          >
            {showTechnical ? '隐藏技术事件' : '显示技术事件'}
          </button>
        </div>
      ) : null}
      <div
        className="event-feed"
        role="log"
        aria-label="会话活动记录"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
      >
        {groups.map((group, index) => (
          <section
            className="feed-turn"
            key={group.turnSeq ?? `pre-${index}`}
            aria-label={group.turnSeq ? `回合 ${group.turnSeq}` : '会话开始'}
          >
            {group.turnSeq ? (
              <div className="feed-turn-label">任务回合</div>
            ) : null}
            {group.rows.map((row) => (
              <FeedRowView row={row} key={row.seq} />
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
