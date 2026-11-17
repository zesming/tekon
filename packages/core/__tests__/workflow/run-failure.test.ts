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

  it('PD-17 步 3：run.retried 也是失败边界，重试前的旧失败不再显示，重试后的新失败照常上报', () => {
    expect(
      findLatestRunFailure([
        { type: 'gate.execution.error', payload: { error: 'old', diagnostic } },
        { type: 'run.retried', payload: { fromStatus: 'failed', toStatus: 'running' } },
        { type: 'node.started', payload: {} },
      ]),
    ).toBeUndefined();

    expect(
      findLatestRunFailure([
        { type: 'gate.execution.error', payload: { error: 'old', diagnostic } },
        { type: 'run.retried', payload: { fromStatus: 'failed', toStatus: 'running' } },
        {
          type: 'node.interrupted',
          payload: { error: 'new', diagnostic: { code: 'timeout', message: 'new timeout' } },
        },
      ]),
    ).toMatchObject({ kind: 'timeout', message: 'new timeout' });
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

  it('ignores a repair failure that a later attempt recovered from', () => {
    expect(
      findLatestRunFailure([
        { type: 'gate.repair.failed', payload: { nodeId: 'rd', error: '529', diagnostic: { code: 'exit-nonzero', message: 'claude 退出码 1：529' } } },
        { type: 'gate.passed-after-repair', payload: { nodeId: 'rd' } },
        { type: 'node.passed', payload: { nodeId: 'rd' } },
        { type: 'gate.failed', payload: { nodeId: 'qa' } },
      ]),
    ).toBeUndefined();
  });

  it('ignores a review rerun failure once the review node passed', () => {
    expect(
      findLatestRunFailure([
        { type: 'gate.rework.review.re-execute.failed', payload: { reviewNodeId: 'review', error: 'x', diagnostic } },
        { type: 'node.passed', payload: { nodeId: 'review' } },
      ]),
    ).toBeUndefined();
  });

  it('PD-31: surfaces a deterministic fail-fast skip as the blocked reason with its hint', () => {
    expect(
      findLatestRunFailure([
        { type: 'run.resumed', payload: {} },
        {
          type: 'node.resume-skipped-deterministic',
          payload: {
            nodeId: 'rd',
            classification: 'missing-command',
            reason: '门禁绑定的检查命令仍缺失（missing-command）',
            hint: '在 .tekon/repo-profile.yaml 补全 commands.build',
          },
        },
      ]),
    ).toEqual({
      kind: 'deterministic-block',
      message: '门禁绑定的检查命令仍缺失（missing-command）',
      hint: '在 .tekon/repo-profile.yaml 补全 commands.build',
    });
  });
});
