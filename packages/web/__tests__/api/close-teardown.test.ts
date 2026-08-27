import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';
import { SESSION_EVENT_SCHEMA_VERSION } from '@tekon/core';
import type { SessionEvent } from '@tekon/core';

// F7-P0-07: on shutdown, close() must detach the readiness + auto-prepare
// automation listeners BEFORE db.close(). Otherwise a gate/result (re-arms a
// readiness debounce timer) or an agent/status:passed (fires an auto-prepare
// enqueue) arriving during/after shutdown enqueues against the closed db —
// "[readiness] enqueue failed: The database connection is not open". This test
// publishes both event types after close() and asserts no such late enqueue.

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) cleanup();
  vi.restoreAllMocks();
});

function event(type: string, sessionId: string, payload: object): SessionEvent {
  return {
    sessionId,
    seq: 1,
    type,
    version: SESSION_EVENT_SCHEMA_VERSION,
    timestamp: '2026-08-27T00:00:00.000Z',
    payload: payload as Record<string, unknown>,
    visibility: 'ui-only',
    modelVisible: false,
    sourceEventSeqs: [],
    correlationId: null,
  };
}

describe('createApiCaller close() automation-listener teardown (F7-P0-07)', () => {
  it('does not enqueue against the closed db when automation events arrive after close', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const bus = api.bus;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await api.close();

    // After close() the automation listeners must be detached. Publishing these
    // would (pre-fix) re-arm the 500ms readiness timer and fire the synchronous
    // auto-prepare enqueue against the now-closed db.
    bus.publish(event('gate/result', 'sess_late', { status: 'passed' }));
    bus.publish(event('approval/decided', 'sess_late', { decisionId: 'd1' }));
    bus.publish(event('agent/status', 'sess_late', { status: 'passed' }));

    // Wait past the readiness debounce window (500ms) so a leaked timer would
    // have fired and logged its failure.
    await new Promise((resolve) => setTimeout(resolve, 700));

    const enqueueFailures = errorSpy.mock.calls.filter((args) =>
      args.some(
        (arg) =>
          typeof arg === 'string' &&
          (arg.includes('[readiness] enqueue failed') ||
            arg.includes('[auto-prepare] enqueue failed')),
      ),
    );
    expect(
      enqueueFailures,
      `late enqueue after close: ${JSON.stringify(enqueueFailures)}`,
    ).toEqual([]);
  });

  it('waits for an auto-prepare callback that started before close', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const workspace = await api.sessions.getOrCreateDefaultWorkspace(
      fixture.projectRoot,
    );
    const session = await api.sessions.createSession({
      workspaceId: workspace.id,
      title: 'shutdown race',
      profile: 'autonomous-delivery',
      runId: null,
    });

    let lookupStartedResolve!: () => void;
    const lookupStarted = new Promise<void>((resolve) => {
      lookupStartedResolve = resolve;
    });
    let releaseLookup!: () => void;
    const lookupGate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const originalGetSession = api.sessions.getSession.bind(api.sessions);
    vi.spyOn(api.sessions, 'getSession').mockImplementation(
      async (sessionId) => {
        if (sessionId === session.id) {
          lookupStartedResolve();
          await lookupGate;
        }
        return originalGetSession(sessionId);
      },
    );

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.bus.publish(
      event('agent/status', session.id, { status: 'passed' }),
    );
    await lookupStarted;

    let closeFinished = false;
    const closePromise = api.close().then(() => {
      closeFinished = true;
    });

    try {
      // The callback is suspended inside getSession(). close() must wait for it
      // instead of closing SQLite underneath it.
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(closeFinished).toBe(false);
    } finally {
      releaseLookup();
      await closePromise;
    }

    const enqueueFailures = errorSpy.mock.calls.filter((args) =>
      args.some(
        (arg) =>
          typeof arg === 'string' &&
          arg.includes('[auto-prepare] enqueue failed'),
      ),
    );
    expect(
      enqueueFailures,
      `in-flight callback wrote after close: ${JSON.stringify(enqueueFailures)}`,
    ).toEqual([]);
  });

});
