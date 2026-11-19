import { describe, expect, it } from 'vitest';

import { buildClaudeCodeCommand } from '../../src/runtime/claude-code-adapter.js';
import { buildCodexCommand } from '../../src/runtime/codex-adapter.js';
import type { AgentAdapterConfig } from '../../src/types/config.js';

// PD-10：角色级 model/effort 经 providerOverrides 注入，由适配器翻译成
// harness 参数；不能 honor 的组合显式报错而不是静默丢弃。
const claudeConfig: AgentAdapterConfig = {
  provider: 'claude-code',
  command: 'claude',
  args: [],
  promptMode: 'stdin',
  outputFormat: 'json',
  timeoutMs: 1000,
  permissionProfile: {
    sandbox: 'workspace-write',
    approval: 'acceptEdits',
    filesystemScope: ['/tmp/repo'],
    network: 'restricted',
    tools: { allow: [], deny: [] },
  },
};

const codexConfig: AgentAdapterConfig = {
  provider: 'codex',
  command: 'codex',
  args: [],
  promptMode: 'stdin',
  outputFormat: 'text',
  timeoutMs: 1000,
  permissionProfile: {
    sandbox: 'workspace-write',
    approval: 'acceptEdits',
    filesystemScope: ['/tmp/repo'],
    network: 'restricted',
    tools: { allow: [], deny: [] },
  },
};

describe('PD-10 provider overrides translation', () => {
  it('claude translates a role model into a controlled --model flag', () => {
    const command = buildClaudeCodeCommand(
      claudeConfig,
      { prompt: 'hi' },
      undefined,
      { model: 'claude-opts-5-5' },
    );
    expect(command.args).toContain('--model');
    expect(command.args[command.args.indexOf('--model') + 1]).toBe(
      'claude-opts-5-5',
    );
  });

  it('claude fails explicitly when an effort override cannot be honored', () => {
    // Claude Code 没有稳定的 effort CLI 边界；静默忽略会让角色声明失真，
    // 必须在节点启动前显式报错。
    expect(() =>
      buildClaudeCodeCommand(claudeConfig, { prompt: 'hi' }, undefined, {
        effort: 'high',
      }),
    ).toThrow(/effort/i);
  });

  it('codex translates a role model into a controlled --model flag', () => {
    const command = buildCodexCommand(
      codexConfig,
      {
        prompt: 'hi',
        artifactOutputDir: '/tmp/repo/.tekon/runs/run_x/node_y',
        runContext: { runId: 'run_x', nodeId: 'node_y' },
      },
      { model: 'gpt-whatever' },
    );
    expect(command.args).toContain('--model');
    expect(command.args[command.args.indexOf('--model') + 1]).toBe(
      'gpt-whatever',
    );
  });

  it('codex translates effort into a controlled reasoning-effort config', () => {
    const command = buildCodexCommand(
      codexConfig,
      {
        prompt: 'hi',
        artifactOutputDir: '/tmp/repo/.tekon/runs/run_x/node_y',
        runContext: { runId: 'run_x', nodeId: 'node_y' },
      },
      { effort: 'high' },
    );
    // 内部控制位（不经 user args 安全校验），值受白名单字符约束。
    expect(command.args.some((a) => a.includes('model_reasoning_effort'))).toBe(
      true,
    );
    expect(command.args.join(' ')).toContain('model_reasoning_effort=high');
  });

  it('rejects effort values with shell-unsafe characters before they reach argv', () => {
    expect(() =>
      buildCodexCommand(
        codexConfig,
        {
          prompt: 'hi',
          artifactOutputDir: '/tmp/repo/.tekon/runs/run_x/node_y',
          runContext: { runId: 'run_x', nodeId: 'node_y' },
        },
        { effort: 'high; rm -rf /' },
      ),
    ).toThrow(/effort/i);
  });

  // S3：注入对抗向量矩阵。两个适配器的 build 纯函数都必须 fail-closed，
  // 不依赖上游 resolve 函数的预校验。
  const attackVectors = [
    '--some-flag',
    '-x',
    'value with space',
    'tab\tvalue',
    'newline\nvalue',
    '$(curl evil)',
    '`id`',
    '../escape',
    'a;rm',
    'a|cat',
    'a&whoami',
    '$HOME',
    '*',
    '.hidden',
    '_under',
    '-leading-dash',
    'x'.repeat(65),
  ];

  it.each(attackVectors)(
    'codex rejects the unsafe model/effort vector %j',
    (vector) => {
      expect(() =>
        buildCodexCommand(
          codexConfig,
          {
            prompt: 'hi',
            artifactOutputDir: '/tmp/repo/.tekon/runs/run_x/node_y',
            runContext: { runId: 'run_x', nodeId: 'node_y' },
          },
          { model: vector },
        ),
      ).toThrow(/ROLE_OVERRIDE_INVALID/);
      expect(() =>
        buildCodexCommand(
          codexConfig,
          {
            prompt: 'hi',
            artifactOutputDir: '/tmp/repo/.tekon/runs/run_x/node_y',
            runContext: { runId: 'run_x', nodeId: 'node_y' },
          },
          { effort: vector },
        ),
      ).toThrow(/ROLE_OVERRIDE_INVALID/);
    },
  );

  it.each(attackVectors)(
    'claude rejects the unsafe model vector %j',
    (vector) => {
      expect(() =>
        buildClaudeCodeCommand(claudeConfig, { prompt: 'hi' }, undefined, {
          model: vector,
        }),
      ).toThrow(/ROLE_OVERRIDE_INVALID/);
    },
  );

  it('accepts legitimate namespaced model names on both adapters', () => {
    const legitimate = ['gpt-4.1', 'claude-opts-5-5', 'model_2027', 'A1'];
    for (const model of legitimate) {
      const claude = buildClaudeCodeCommand(
        claudeConfig,
        { prompt: 'hi' },
        undefined,
        { model },
      );
      expect(claude.args[claude.args.indexOf('--model') + 1]).toBe(model);
      const codex = buildCodexCommand(
        codexConfig,
        {
          prompt: 'hi',
          artifactOutputDir: '/tmp/repo/.tekon/runs/run_x/node_y',
          runContext: { runId: 'run_x', nodeId: 'node_y' },
        },
        { model },
      );
      expect(codex.args[codex.args.indexOf('--model') + 1]).toBe(model);
    }
  });

  it('emits no override flags when no overrides are provided', () => {
    const claude = buildClaudeCodeCommand(claudeConfig, { prompt: 'hi' });
    expect(claude.args).not.toContain('--model');
    const codex = buildCodexCommand(codexConfig, {
      prompt: 'hi',
      artifactOutputDir: '/tmp/repo/.tekon/runs/run_x/node_y',
      runContext: { runId: 'run_x', nodeId: 'node_y' },
    });
    expect(codex.args).not.toContain('--model');
    expect(codex.args.some((a) => a.includes('reasoning_effort'))).toBe(false);
  });
});
