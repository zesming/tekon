import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { EventFeed } from '../../src/client/components/sessions/EventFeed.js';
import type { StreamEvent } from '../../src/client/lib/session-stream.js';

const sampleEvent: StreamEvent = {
  seq: 1,
  type: 'assistant/message',
  timestamp: '2026-08-31T00:00:00.000Z',
  payload: { text: 'hello', synthetic: false },
  visibility: 'model',
  modelVisible: true,
  correlationId: null,
};

describe('EventFeed history boundary messaging', () => {
  it('shows replay truncation even when no business event is currently visible', () => {
    const html = renderToStaticMarkup(
      React.createElement(EventFeed, {
        events: [],
        truncated: true,
        onDismissTruncated: () => {},
      }),
    );

    expect(html).toContain('feed-truncation-banner');
    expect(html).toContain('已切换到最近记录');
    expect(html).toContain('最多额外保留 2000 条');
    expect(html).toContain('等待事件');
  });

  it('describes the client retention cap as a page limit, not the start of history', () => {
    const html = renderToStaticMarkup(
      React.createElement(EventFeed, {
        events: [sampleEvent],
        hasEarlier: true,
        reachedEarlierLimit: true,
        onLoadEarlier: () => {},
      }),
    );

    expect(html).toContain('已达本页历史上限');
    expect(html).toContain('本页最多额外保留 2000 条更早记录');
    expect(html).toContain('达到上限不等于已加载最早历史');
  });
});
