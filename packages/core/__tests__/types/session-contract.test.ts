import { describe, it, expect } from 'vitest';

import {
  SESSION_EVENT_SCHEMA_VERSION,
  sessionEventSchema,
  sessionSchema,
  jobSchema,
  CORE_SESSION_EVENT_TYPES,
  CONTROL_EVENT_TYPES,
  TEKON_GOVERNANCE_EVENT_TYPES,
  REQUIRED_EVENT_TYPES,
  type KnownSessionEventType,
} from '../../src/types/session-contract.js';

// ---------------------------------------------------------------------------
// Contract-freeze tests for the Harness-inspired replatform (phase 0).
//
// These lock the *shape* of the target Session/Event contract so later phases
// build against a stable, reviewed vocabulary. They intentionally assert the
// frozen invariants (schema version, required core, monotonic seq, merge-
// extensible unknown types) rather than any runtime behavior — there is no
// implementation yet.
// ---------------------------------------------------------------------------

describe('session contract v1 (frozen draft)', () => {
  it('pins the schema version at 1', () => {
    expect(SESSION_EVENT_SCHEMA_VERSION).toBe(1);
  });

  it('parses a well-formed session event with defaults', () => {
    const parsed = sessionEventSchema.parse({
      sessionId: 'sess_1',
      seq: 0,
      type: 'session/created',
      version: 1,
      timestamp: '2026-08-20T00:00:00.000Z',
    });
    // Defaults are applied for optional fields.
    expect(parsed.payload).toEqual({});
    expect(parsed.visibility).toBe('ui-only');
    expect(parsed.modelVisible).toBe(false);
    expect(parsed.sourceEventSeqs).toEqual([]);
    expect(parsed.correlationId).toBeNull();
  });

  it('rejects an event with the wrong schema version', () => {
    expect(() =>
      sessionEventSchema.parse({
        sessionId: 'sess_1',
        seq: 0,
        type: 'user/message',
        version: 2, // only v1 is valid in this frozen draft
        timestamp: '2026-08-20T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('rejects a negative sequence number (seq is monotonic, >= 0)', () => {
    expect(() =>
      sessionEventSchema.parse({
        sessionId: 'sess_1',
        seq: -1,
        type: 'user/message',
        version: 1,
        timestamp: '2026-08-20T00:00:00.000Z',
      }),
    ).toThrow();
  });

  it('accepts an unknown/merged event type (merge-extensible vocabulary)', () => {
    // Plugins may declare extra event types; the base schema must not reject
    // a well-formed event just because its type is not in the known set.
    const parsed = sessionEventSchema.parse({
      sessionId: 'sess_1',
      seq: 5,
      type: 'compaction/summary',
      version: 1,
      timestamp: '2026-08-20T00:00:00.000Z',
    });
    expect(parsed.type).toBe('compaction/summary');
  });

  it('includes the model-visible flag for replay/context reconstruction', () => {
    const parsed = sessionEventSchema.parse({
      sessionId: 'sess_1',
      seq: 3,
      type: 'assistant/message',
      version: 1,
      timestamp: '2026-08-20T00:00:00.000Z',
      visibility: 'model',
      modelVisible: true,
    });
    expect(parsed.modelVisible).toBe(true);
    expect(parsed.visibility).toBe('model');
  });

  it('keeps the required core event types within the known vocabulary', () => {
    const known = new Set<KnownSessionEventType>([
      ...CORE_SESSION_EVENT_TYPES,
      ...CONTROL_EVENT_TYPES,
      ...TEKON_GOVERNANCE_EVENT_TYPES,
    ]);
    for (const required of REQUIRED_EVENT_TYPES) {
      expect(known.has(required)).toBe(true);
    }
    // Sanity: the turn/step vocabulary that the streaming loop depends on.
    expect(known.has('turn/start')).toBe(true);
    expect(known.has('step/start')).toBe(true);
    expect(known.has('tool/call')).toBe(true);
    expect(known.has('tool/result')).toBe(true);
  });

  it('has no overlap between core, control, and governance event sets', () => {
    const all = [
      ...CORE_SESSION_EVENT_TYPES,
      ...CONTROL_EVENT_TYPES,
      ...TEKON_GOVERNANCE_EVENT_TYPES,
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  // 4e: readiness/evaluated is a governance event (delivery readiness projection).
  it('includes the 4e readiness/evaluated governance event', () => {
    expect(TEKON_GOVERNANCE_EVENT_TYPES).toContain('readiness/evaluated');
  });

  it('validates session and job shapes', () => {
    expect(() =>
      sessionSchema.parse({
        id: 'sess_1',
        workspaceId: 'ws_1',
        title: null,
        profile: 'human-web',
        status: 'active',
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      }),
    ).not.toThrow();

    expect(() =>
      jobSchema.parse({
        id: 'job_1',
        sessionId: 'sess_1',
        kind: 'workflow-run',
        status: 'queued',
        owner: null,
        lease: null,
        abortState: 'none',
        checkpoint: null,
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
      }),
    ).not.toThrow();
  });
});
