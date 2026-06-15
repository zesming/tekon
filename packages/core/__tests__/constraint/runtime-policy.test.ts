import { describe, expect, it } from 'vitest';

import {
  canSatisfyGate,
  compileRoleRuntimePolicy,
  requiresHumanApproval,
  type RoleRuntimePolicy,
} from '../../src/constraint/runtime-policy.js';
import type { RoleAgentConfig } from '../../src/role/loader.js';

describe('compileRoleRuntimePolicy', () => {
  it('applies default autonomy level and risk tolerance when none provided', () => {
    const config: RoleAgentConfig = {
      role: 'rd',
      injectMode: 'append',
      priority: 0,
      knowledgeFiles: [],
    };

    const policy = compileRoleRuntimePolicy(config);

    expect(policy.autonomy.level).toBe('review-gated');
    expect(policy.autonomy.riskTolerance).toBe('medium');
    expect(policy.requiresHumanApproval).toEqual([]);
    expect(policy.defaultTimeoutMs).toBeUndefined();
    expect(policy.allowedGateTags).toBeUndefined();
  });

  it('uses explicit autonomy and riskTolerance from agent config', () => {
    const config: RoleAgentConfig = {
      role: 'qa',
      injectMode: 'append',
      priority: 0,
      knowledgeFiles: [],
      autonomy: { level: 'auto-pr', riskTolerance: 'high' },
    };

    const policy = compileRoleRuntimePolicy(config);

    expect(policy.autonomy.level).toBe('auto-pr');
    expect(policy.autonomy.riskTolerance).toBe('high');
  });

  it('passes through requiresHumanApprovalFor rules', () => {
    const config: RoleAgentConfig = {
      role: 'rd',
      injectMode: 'append',
      priority: 0,
      knowledgeFiles: [],
      requiresHumanApprovalFor: [
        { filePatterns: ['*.env'] },
        { toolPatterns: ['git push --force'] },
        { actionTypes: ['deploy'] },
      ],
    };

    const policy = compileRoleRuntimePolicy(config);

    expect(policy.requiresHumanApproval).toHaveLength(3);
    expect(policy.requiresHumanApproval[0]).toEqual({
      filePatterns: ['*.env'],
    });
    expect(policy.requiresHumanApproval[1]).toEqual({
      toolPatterns: ['git push --force'],
    });
    expect(policy.requiresHumanApproval[2]).toEqual({
      actionTypes: ['deploy'],
    });
  });

  it('passes through defaultTimeoutMs and allowedGateTags', () => {
    const config: RoleAgentConfig = {
      role: 'reviewer',
      injectMode: 'append',
      priority: 0,
      knowledgeFiles: [],
      defaultTimeoutMs: 600000,
      allowedGateTags: ['build', 'test', 'lint'],
    };

    const policy = compileRoleRuntimePolicy(config);

    expect(policy.defaultTimeoutMs).toBe(600000);
    expect(policy.allowedGateTags).toEqual(['build', 'test', 'lint']);
  });
});

describe('requiresHumanApproval', () => {
  const policyWithRules: RoleRuntimePolicy = {
    autonomy: { level: 'review-gated', riskTolerance: 'medium' },
    requiresHumanApproval: [
      { filePatterns: ['*.env', '**/secrets/**'] },
      { toolPatterns: ['git push --force', 'git push*--force*'] },
      { actionTypes: ['deploy', 'production-access'] },
    ],
  };

  it('returns false when policy has no rules', () => {
    const emptyPolicy: RoleRuntimePolicy = {
      autonomy: { level: 'review-gated', riskTolerance: 'medium' },
      requiresHumanApproval: [],
    };

    expect(
      requiresHumanApproval(emptyPolicy, {
        files: ['.env'],
        tools: ['git push --force'],
        actions: ['deploy'],
      }),
    ).toBe(false);
  });

  it('returns true when file matches a filePattern', () => {
    expect(
      requiresHumanApproval(policyWithRules, { files: ['.env'] }),
    ).toBe(true);
  });

  it('returns true when file matches a recursive glob pattern', () => {
    expect(
      requiresHumanApproval(policyWithRules, {
        files: ['src/secrets/api-key.txt'],
      }),
    ).toBe(true);
  });

  it('returns true when tool matches a toolPattern', () => {
    expect(
      requiresHumanApproval(policyWithRules, {
        tools: ['git push --force'],
      }),
    ).toBe(true);
  });

  it('returns true when action matches an actionType', () => {
    expect(
      requiresHumanApproval(policyWithRules, { actions: ['deploy'] }),
    ).toBe(true);
  });

  it('returns false when nothing matches', () => {
    expect(
      requiresHumanApproval(policyWithRules, {
        files: ['src/index.ts'],
        tools: ['git commit'],
        actions: ['review'],
      }),
    ).toBe(false);
  });

  it('returns false when context is empty', () => {
    expect(requiresHumanApproval(policyWithRules, {})).toBe(false);
  });

  it('handles rules with mixed pattern types', () => {
    const mixedPolicy: RoleRuntimePolicy = {
      autonomy: { level: 'restricted', riskTolerance: 'low' },
      requiresHumanApproval: [
        {
          filePatterns: ['*.env'],
          toolPatterns: ['rm *'],
          actionTypes: ['deploy'],
        },
      ],
    };

    expect(
      requiresHumanApproval(mixedPolicy, { files: ['.env'] }),
    ).toBe(true);
    expect(
      requiresHumanApproval(mixedPolicy, { tools: ['rm -rf tmp'] }),
    ).toBe(true);
    expect(
      requiresHumanApproval(mixedPolicy, { actions: ['deploy'] }),
    ).toBe(true);
    expect(
      requiresHumanApproval(mixedPolicy, { files: ['src/main.ts'] }),
    ).toBe(false);
  });
});

describe('canSatisfyGate', () => {
  it('returns true when policy has no allowedGateTags restriction', () => {
    const policy: RoleRuntimePolicy = {
      autonomy: { level: 'review-gated', riskTolerance: 'medium' },
      requiresHumanApproval: [],
    };

    expect(canSatisfyGate(policy, ['build', 'test'])).toBe(true);
  });

  it('returns true when policy has empty allowedGateTags array', () => {
    const policy: RoleRuntimePolicy = {
      autonomy: { level: 'review-gated', riskTolerance: 'medium' },
      requiresHumanApproval: [],
      allowedGateTags: [],
    };

    // Empty allowedGateTags means no restriction
    expect(canSatisfyGate(policy, ['build'])).toBe(true);
  });

  it('returns true when all gate tags are in allowedGateTags', () => {
    const policy: RoleRuntimePolicy = {
      autonomy: { level: 'auto-pr', riskTolerance: 'high' },
      requiresHumanApproval: [],
      allowedGateTags: ['build', 'test', 'lint', 'e2e-pass'],
    };

    expect(canSatisfyGate(policy, ['build', 'test'])).toBe(true);
  });

  it('returns false when a gate tag is not in allowedGateTags', () => {
    const policy: RoleRuntimePolicy = {
      autonomy: { level: 'restricted', riskTolerance: 'low' },
      requiresHumanApproval: [],
      allowedGateTags: ['build', 'lint'],
    };

    expect(canSatisfyGate(policy, ['build', 'deploy'])).toBe(false);
  });

  it('returns true when checking empty gate tags', () => {
    const policy: RoleRuntimePolicy = {
      autonomy: { level: 'restricted', riskTolerance: 'low' },
      requiresHumanApproval: [],
      allowedGateTags: ['build'],
    };

    expect(canSatisfyGate(policy, [])).toBe(true);
  });
});
