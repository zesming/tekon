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
  if (events.length === 0) {
    return (
      <div className="feed-empty text-muted" role="status" aria-live="polite">
        等待事件… Waiting for session events.
      </div>
    );
  }
  const groups = groupEventsByTurn(events);
  return (
    <div className="event-feed">
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
  );
}
