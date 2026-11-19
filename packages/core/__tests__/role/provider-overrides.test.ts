import { describe, expect, it } from 'vitest';

import { resolveRoleProviderOverrides } from '../../src/role/provider-overrides.js';
import { isSafeProviderOverrideValue } from '../../src/role/override-safety.js';
import type { LoadedRole } from '../../src/role/loader.js';
import type { RunProviderConfig } from '../../src/types/domain.js';

function roleWith(agent: Partial<LoadedRole['agent']>): LoadedRole {
  return {
    role: 'rd',
    source: 'built-in',
    roleDir: '/roles/rd',
    systemPrompt: 'system',
    skills: [],
    knowledge: [],
    tools: {
      network: 'disabled',
      allow: [],
      deny: [],
      requiresHumanApproval: [],
    },
    agent: {
      role: 'rd',
      injectMode: 'append',
      priority: 0,
      knowledgeFiles: [],
      ...agent,
    },
  };
}

function provider(provider: RunProviderConfig['provider']): RunProviderConfig {
  return {
    runId: 'run_1',
    provider,
    configSummary: {},
    createdAt: '2026-11-17T00:00:00.000Z',
  };
}

describe('PD-10 resolveRoleProviderOverrides', () => {
  it('returns undefined when the role declares no overrides', () => {
    expect(
      resolveRoleProviderOverrides(
        'run_1',
        'rd',
        roleWith({}),
        provider('claude-code'),
      ),
    ).toBeUndefined();
  });

  it('passes model/effort through for a matching real provider', () => {
    expect(
      resolveRoleProviderOverrides(
        'run_1',
        'rd',
        roleWith({ model: 'gpt-x', effort: 'high' }),
        provider('codex'),
      ),
    ).toEqual({ model: 'gpt-x', effort: 'high' });
  });

  it('ignores overrides entirely for the mock test adapter', () => {
    expect(
      resolveRoleProviderOverrides(
        'run_1',
        'rd',
        roleWith({ driver: 'claude-code', model: 'm' }),
        provider('mock'),
      ),
    ).toBeUndefined();
  });

  it('treats a missing provider snapshot like mock (no hard failure)', () => {
    expect(
      resolveRoleProviderOverrides(
        'run_1',
        'rd',
        roleWith({ model: 'm' }),
        null,
      ),
    ).toBeUndefined();
  });

  it('fails explicitly when the declared driver differs from the run provider', () => {
    expect(() =>
      resolveRoleProviderOverrides(
        'run_1',
        'rd',
        roleWith({ driver: 'codex', model: 'gpt-x' }),
        provider('claude-code'),
      ),
    ).toThrow(/ROLE_DRIVER_MISMATCH/);
  });

  it('accepts a driver declaration that matches the run provider', () => {
    expect(
      resolveRoleProviderOverrides(
        'run_1',
        'rd',
        roleWith({ driver: 'claude-code', model: 'sonnet-x' }),
        provider('claude-code'),
      ),
    ).toEqual({ model: 'sonnet-x' });
  });

  // 残留加固：resolve 主收口自身也要 fail-closed，不依赖适配器 build 的二次断言。
  it.each([
    ['driver', { driver: '--flag' }],
    ['model', { model: 'x; rm' }],
    ['effort', { effort: 'high $(id)' }],
  ])(
    'rejects an unsafe %s at the resolve layer with ROLE_OVERRIDE_INVALID',
    (_field, agent) => {
      expect(() =>
        resolveRoleProviderOverrides(
          'run_1',
          'rd',
          roleWith(agent),
          provider('claude-code'),
        ),
      ).toThrow(/ROLE_OVERRIDE_INVALID/);
    },
  );
});

describe('PD-10 isSafeProviderOverrideValue predicate', () => {
  it('accepts legitimate identifiers and rejects injection-shaped values', () => {
    for (const safe of [
      'gpt-4.1',
      'claude-opts-5-5',
      'A1',
      'model_2027',
      'x',
    ]) {
      expect(isSafeProviderOverrideValue(safe)).toBe(true);
    }
    for (const unsafe of [
      '--flag',
      '-x',
      'a b',
      'a;b',
      '$(id)',
      '`id`',
      '../x',
      '.hidden',
      '_under',
      '-dash',
      'x'.repeat(65),
      '',
    ]) {
      expect(isSafeProviderOverrideValue(unsafe)).toBe(false);
    }
  });
});
