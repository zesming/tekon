import { describe, expect, it } from 'vitest';

import { findLatestRunFailure } from '../../src/workflow/run-failure.js';

const diagnostic = {
  code: 'not-authenticated',
  message: 'claude 未登录或凭据无效',
  hint: '执行 claude /login',
};

describe('findLatestRunFailure', () => {
  it('returns the newest classified failure', () => {
    expect(
      findLatestRunFailure([
        { type: 'node.interrupted', payload: { error: 'old', diagnostic: { code: 'timeout', message: 'old' } } },
        { type: 'node.started', payload: {} },
        { type: 'gate.execution.error', payload: { error: 'x', diagnostic } },
      ]),
    ).toEqual({ kind: 'not-authenticated', message: diagnostic.message, hint: diagnostic.hint });
  });

  it('ignores failures that a later resume addressed', () => {
    expect(
      findLatestRunFailure([
        { type: 'node.interrupted', payload: { error: 'x', diagnostic } },
        { type: 'run.resumed', payload: {} },
        { type: 'node.started', payload: {} },
      ]),
    ).toBeUndefined();
  });

  it('falls back to the redacted error text for unclassified failures', () => {
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const reason = findLatestRunFailure([
      { type: 'node.interrupted', payload: { error: `lease failed ${secret}` } },
    ]);
    expect(reason?.message).toContain('lease failed');
    expect(reason?.message).not.toContain(secret);
    expect(reason?.kind).toBeUndefined();
  });

  it.each(['gate.repair.failed', 'gate.rework.review.re-execute.failed'])(
    'reads the reason of a failed %s',
    (type) => {
      expect(findLatestRunFailure([{ type, payload: { error: 'x', diagnostic } }])).toMatchObject({
        kind: 'not-authenticated',
      });
    },
  );
});
