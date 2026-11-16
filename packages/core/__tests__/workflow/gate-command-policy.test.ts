import { describe, expect, it } from 'vitest';

import { evaluateCommandPolicy } from '../../src/runtime/command-gateway.js';
import {
  defaultCommandPolicy,
  gateCommandPolicy,
} from '../../src/workflow/workflow-runtime.js';
import type { CommandInvocation, WorkflowGateConfig } from '../../src/index.js';

// PD-04：用户手写在模板/repo-profile 里的命令视为已授权，allow 由它们推导；
// 固定拒绝规则（shell 元字符、网络、危险删除、force push）继续生效。
describe('PD-04 user-authorized gate commands', () => {
  const cwd = '/repo/worktree';
  const python: CommandInvocation = { tool: 'python3', args: ['task.py'] };
  const make: CommandInvocation = { tool: 'make', args: ['test'] };

  it('rejects non-baseline tools under the default fixed policy', () => {
    const policy = defaultCommandPolicy(cwd);
    expect(evaluateCommandPolicy(python, policy, cwd)).toMatch(/allow policy/u);
    expect(evaluateCommandPolicy(make, policy, cwd)).toMatch(/allow policy/u);
  });

  it('accepts user-authorized tools once derived from the gate command', () => {
    const gate: WorkflowGateConfig = {
      type: 'build',
      command: python,
      requiresHumanApproval: false,
      maxRetries: 0,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed',
        onExhausted: 'block',
      },
    };
    const policy = gateCommandPolicy(cwd, gate);

    expect(evaluateCommandPolicy(python, policy, cwd)).toBeNull();
    // 基线工具仍然可用。
    expect(
      evaluateCommandPolicy({ tool: 'git', args: ['status'] }, policy, cwd),
    ).toBeNull();
  });

  it('keeps rejecting dangerous commands even when user-authorized', () => {
    const forcedRemove: CommandInvocation = {
      tool: 'rm',
      args: ['-rf', '/tmp/anything'],
    };
    const policy = gateCommandPolicy(cwd, {
      type: 'build',
      command: forcedRemove,
      requiresHumanApproval: false,
      maxRetries: 0,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed',
        onExhausted: 'block',
      },
    });

    expect(evaluateCommandPolicy(forcedRemove, policy, cwd)).toMatch(
      /recursive forced remove/u,
    );
  });

  it('keeps rejecting network commands under the disabled default', () => {
    const curl: CommandInvocation = {
      tool: 'curl',
      args: ['https://example.test'],
    };
    const policy = gateCommandPolicy(cwd, {
      type: 'build',
      command: curl,
      requiresHumanApproval: false,
      maxRetries: 0,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed',
        onExhausted: 'block',
      },
    });

    expect(evaluateCommandPolicy(curl, policy, cwd)).toMatch(/network/u);
  });

  it('rejects shell metacharacters in user-authorized commands', () => {
    const injection: CommandInvocation = {
      tool: 'python3;rm',
      args: [],
    };
    const policy = gateCommandPolicy(cwd, {
      type: 'build',
      command: injection,
      requiresHumanApproval: false,
      maxRetries: 0,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed',
        onExhausted: 'block',
      },
    });

    expect(evaluateCommandPolicy(injection, policy, cwd)).toMatch(
      /metacharacter/u,
    );
  });

  it('does not widen the policy for gates without an inline command', () => {
    const gate: WorkflowGateConfig = {
      type: 'human',
      requiresHumanApproval: true,
      maxRetries: 0,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed',
        onExhausted: 'block',
      },
    };
    const policy = gateCommandPolicy(cwd, gate);
    expect(policy.allow).toHaveLength(defaultCommandPolicy(cwd).allow.length);
  });

  it('keeps authorization per-gate: one gate command does not leak into another gate policy', () => {
    const firstGate: WorkflowGateConfig = {
      type: 'build',
      command: { tool: 'python3', args: ['build.py'] },
      requiresHumanApproval: false,
      maxRetries: 0,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed',
        onExhausted: 'block',
      },
    };
    const secondGate: WorkflowGateConfig = {
      type: 'test',
      requiresHumanApproval: false,
      maxRetries: 0,
      retryPolicy: {
        maxAttempts: 1,
        maxRetries: 0,
        backoffMs: 0,
        strategy: 'fixed',
        onExhausted: 'block',
      },
    };

    // 第一个门禁授权 python3，第二个独立构造的门禁不继承该授权。
    gateCommandPolicy(cwd, firstGate);
    const secondPolicy = gateCommandPolicy(cwd, secondGate);
    expect(
      evaluateCommandPolicy(
        { tool: 'python3', args: ['build.py'] },
        secondPolicy,
        cwd,
      ),
    ).toMatch(/allow policy/u);
  });
});
