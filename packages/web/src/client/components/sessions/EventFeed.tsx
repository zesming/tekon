import { useMemo, useState } from 'react';

import { CodeBlock } from '../ui/CodeBlock.js';
import {
  computeEventWindow,
  DEFAULT_EVENT_WINDOW,
  groupEventsByTurn,
  type FeedRow,
} from '../../lib/event-feed.js';
import type { StreamEvent } from '../../lib/session-stream.js';

// Phase 3 3b / T6: renders the session event stream as a continuous narrative
// with DOM windowing and bounded single-payload display.

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

function FeedMessageBody({ content }: { content: string }) {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > 350 || content.split('\n').length > 8;

  return (
    <div className="feed-message-body-wrapper">
      <div
        className="feed-message-body"
        style={
          isLong && !expanded
            ? {
                maxHeight: '160px',
                overflow: 'hidden',
                position: 'relative',
              }
            : undefined
        }
      >
        {content}
      </div>
      {isLong ? (
        <button
          type="button"
          className="btn btn-ghost btn-xs"
          aria-expanded={expanded}
          onClick={() => setExpanded((prev) => !prev)}
          style={{ fontSize: '11px', color: 'var(--accent)', marginTop: '4px' }}
        >
          {expanded ? '收起长文本' : '展开全文'}
        </button>
      ) : null}
    </div>
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
          <FeedMessageBody content={row.body} />
        ) : (
          <CodeBlock content={row.body} truncated />
        )
      ) : null}
    </div>
  );
}

export function EventFeed({
  events,
  hasEarlier: externalHasEarlier,
  reachedEarlierLimit,
  isLoadingEarlier,
  onLoadEarlier,
  truncated,
  onDismissTruncated,
}: {
  events: StreamEvent[];
  hasEarlier?: boolean;
  reachedEarlierLimit?: boolean;
  isLoadingEarlier?: boolean;
  onLoadEarlier?: () => void;
  truncated?: boolean;
  onDismissTruncated?: () => void;
}) {
  const [showTechnical, setShowTechnical] = useState(false);
  const [showAllHistory, setShowAllHistory] = useState(false);

  // T6: Windowing boundary for long event streams
  const { hasEarlierEvents, hiddenEarlierCount, visibleEvents } = useMemo(
    () => computeEventWindow(events, showAllHistory, DEFAULT_EVENT_WINDOW),
    [events, showAllHistory],
  );

  const allGroups = useMemo(
    () => groupEventsByTurn(visibleEvents),
    [visibleEvents],
  );

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
          rows: showTechnical ? group.rows : group.rows.filter(isNarrativeRow),
        }))
        .filter((group) => group.rows.length > 0),
    [allGroups, showTechnical],
  );

  return (
    <div className="event-feed-shell">
      {truncated ? (
        <div
          className="feed-truncation-banner"
          role="status"
          aria-live="polite"
        >
          <span>
            连接恢复时历史量超过在线回放预算，已切换到最近记录；本页仍可按页加载更早记录，但最多额外保留 2000 条。
          </span>
          {onDismissTruncated ? (
            <button
              type="button"
              className="btn btn-secondary btn-xs"
              aria-label="关闭历史截断提示"
              onClick={onDismissTruncated}
            >
              关闭
            </button>
          ) : null}
        </div>
      ) : null}

      {events.length === 0 ? (
        <div className="feed-empty text-muted" role="status" aria-live="polite">
          等待事件… Waiting for session events.
        </div>
      ) : (
        <>
          <div className="event-feed-toolbar">
            <span className="text-muted">
              {showTechnical
                ? '正在显示完整技术时间线'
                : hiddenTechnicalCount > 0
                  ? `已隐藏 ${hiddenTechnicalCount} 条技术事件`
                  : '叙事时间线'}
            </span>
            <div className="flex gap-2 items-center">
              {externalHasEarlier && onLoadEarlier ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  disabled={isLoadingEarlier || reachedEarlierLimit}
                  title={
                    reachedEarlierLimit
                      ? '本页最多额外保留 2000 条更早记录'
                      : undefined
                  }
                  onClick={onLoadEarlier}
                >
                  {isLoadingEarlier
                    ? '正在加载更早历史…'
                    : reachedEarlierLimit
                      ? '已达本页历史上限'
                      : '加载更早历史'}
                </button>
              ) : null}
              {hasEarlierEvents ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-xs"
                  aria-label={`展开更早的 ${hiddenEarlierCount} 条事件`}
                  onClick={() => setShowAllHistory(true)}
                >
                  展开更早的 {hiddenEarlierCount} 条事件
                </button>
              ) : null}
              {hiddenTechnicalCount > 0 || showTechnical ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  aria-pressed={showTechnical}
                  onClick={() => setShowTechnical((value) => !value)}
                >
                  {showTechnical ? '隐藏技术事件' : '显示技术事件'}
                </button>
              ) : null}
            </div>
          </div>
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
        </>
      )}
    </div>
  );
}
