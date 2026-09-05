import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let snapshot: {
  data?: {
    session: {
      id: string;
      runId: string;
      status: string;
      title: string;
      actionKind: null;
      admissionState?: 'accepted' | 'recovery-required';
      filesState?: 'pending' | 'ready' | 'recovery_required';
    };
  };
  error: Error | null;
} = { error: null };
vi.mock('react-router', () => ({
  useParams: () => ({ sessionId: 'session-pending' }),
}));
vi.mock('../../src/client/hooks/index.js', () => ({
  useAuthScope: () => 'auth-test',
  useQuery: () => ({ ...snapshot, refetch: vi.fn() }),
  useSessionStream: () => ({
    events: [
      { seq: 1, type: 'workflow/started', payload: { runId: 'run-pending' } },
    ],
    connState: 'live',
    hasEarlier: false,
    reachedEarlierLimit: false,
    isLoadingEarlier: false,
    loadEarlier: vi.fn(),
    truncated: false,
    dismissTruncated: vi.fn(),
  }),
}));
vi.mock('../../src/client/components/sessions/EventFeed.js', () => ({
  EventFeed: () => React.createElement('div', null, 'opening-event-arrived'),
}));
vi.mock('../../src/client/components/sessions/SessionSidePanel.js', () => ({
  SessionSidePanel: ({ state }: { state: { runStatus: string } }) =>
    React.createElement('div', null, `execution-controls:${state.runStatus}`),
}));
import { SessionDetailPage } from '../../src/client/pages/SessionDetailPage.js';

const session = {
  id: 'session-pending',
  runId: 'run-pending',
  status: 'active',
  title: '受理快照',
  actionKind: null,
};
describe('authoritative admission snapshot gates session controls', () => {
  for (const scenario of [
    'loading',
    'initial-error',
    'cached-error',
    'pending',
  ] as const) {
    it(`opening events cannot enable controls while snapshot is ${scenario}`, () => {
      snapshot =
        scenario === 'loading'
          ? { error: null }
          : scenario === 'initial-error'
            ? { error: new Error('snapshot unavailable') }
            : scenario === 'cached-error'
              ? {
                  data: { session: { ...session, filesState: 'ready' } },
                  error: new Error('refresh failed'),
                }
              : {
                  data: {
                    session: {
                      ...session,
                      filesState: 'pending',
                      admissionState: 'recovery-required',
                    },
                  },
                  error: null,
                };
      const html = renderToStaticMarkup(React.createElement(SessionDetailPage));
      expect(html).toContain('opening-event-arrived');
      expect(html).not.toContain('execution-controls:running');
    });
  }
  it('enables controls after a successful ready snapshot', () => {
    snapshot = {
      data: {
        session: {
          ...session,
          admissionState: 'accepted',
          filesState: 'ready',
        },
      },
      error: null,
    };
    expect(
      renderToStaticMarkup(React.createElement(SessionDetailPage)),
    ).toContain('execution-controls:running');
  });

  it('a failed refresh retains known acceptance while withholding current execution controls', () => {
    snapshot = {
      data: { session: { ...session, admissionState: 'accepted', filesState: 'ready' } },
      error: new Error('refresh unavailable'),
    };
    const html = renderToStaticMarkup(React.createElement(SessionDetailPage));
    expect(html).toContain('已受理');
    expect(html).toContain('当前状态刷新失败');
    expect(html).not.toContain('受理状态待确认');
    expect(html).not.toContain('execution-controls:');
  });
});
