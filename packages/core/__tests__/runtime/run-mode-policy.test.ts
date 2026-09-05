import { describe, expect, it } from 'vitest';

import { getRunModePolicyIssue } from '../../src/index.js';

describe('run-mode policy', () => {
  it('allows ordinary workflow and goal combinations', () => {
    expect(
      getRunModePolicyIssue({ agent: 'codex', kind: 'workflow' }),
    ).toBeNull();
    expect(
      getRunModePolicyIssue({ agent: 'dsh-headless', kind: 'goal' }),
    ).toBeNull();
  });

  it('rejects dsh-headless for governed workflows', () => {
    expect(
      getRunModePolicyIssue({
        agent: 'dsh-headless',
        kind: 'workflow',
        template: 'standard-delivery',
      }),
    ).toContain('仅支持 goal');
  });

  it('rejects goal combinations that imply workflow or delivery behavior', () => {
    expect(
      getRunModePolicyIssue({
        agent: 'mock',
        kind: 'goal',
        template: 'bugfix',
      }),
    ).toBe('--goal 模式下不能同时指定 --template');
    expect(
      getRunModePolicyIssue({
        agent: 'mock',
        kind: 'goal',
        profile: 'autonomous-delivery',
      }),
    ).toContain('不支持 autonomous-delivery');
  });
});
