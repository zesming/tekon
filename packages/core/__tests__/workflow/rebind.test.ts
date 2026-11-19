import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureRunPlan } from '../../src/workflow/run-plan.js';
import { parseWorkflowTemplate } from '../../src/workflow/template.js';
import type { RunProviderConfig } from '../../src/types/domain.js';
import {
  diffRunBindings,
  inspectCurrentBinding,
  recaptureRunPlan,
} from '../../src/workflow/rebind.js';

// PD-05：默认冻结，--rebind 显式采用当前配置。rebind 的可重绑定面只有
// agent、provider 快照与 repo-profile 命令（repoCommands）；模板结构由
// nodes 行与审计哈希链锚定，不参与重绑定。
describe('PD-05 recaptureRunPlan', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function repoWithProfile(profile: unknown): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-rebind-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(
      join(repoPath, '.tekon', 'repo-profile.yaml'),
      JSON.stringify(profile),
    );
    return repoPath;
  }

  function spec() {
    return parseWorkflowTemplate({
      id: 'rebind-fixture',
      governance: 'none',
      phases: [
        {
          id: 'dev',
          nodes: [
            {
              id: 'rd',
              role: 'rd',
              gates: [{ type: 'build', commandRef: 'build' }],
            },
          ],
        },
      ],
    });
  }

  it('重新捕获且配置未变时产出同一 digest（无差异不产生新绑定身份）', () => {
    const repoPath = repoWithProfile({
      commands: { build: { tool: 'npm', args: ['run', 'build'] } },
    });
    const frozen = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const recaptured = recaptureRunPlan({ repoPath, frozenPlan: frozen });
    expect(recaptured.digest).toBe(frozen.digest);
    expect(recaptured.repoCommands).toEqual(frozen.repoCommands);
    expect(recaptured.agent).toBe('mock');
  });

  it('采用 repo-profile 的新命令后 digest 改变，模板结构保持不变', () => {
    const repoPath = repoWithProfile({ commands: {} });
    const frozen = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    expect(frozen.repoCommands[0]?.status).toBe('missing');

    writeFileSync(
      join(repoPath, '.tekon', 'repo-profile.yaml'),
      JSON.stringify({
        commands: { build: { tool: 'npm', args: ['run', 'build'] } },
      }),
    );
    const recaptured = recaptureRunPlan({ repoPath, frozenPlan: frozen });
    expect(recaptured.digest).not.toBe(frozen.digest);
    expect(recaptured.repoCommands[0]?.status).toBe('resolved');
    // 模板字节身份不变：rebind 不允许改结构。
    expect(recaptured.template).toEqual(frozen.template);
    expect(recaptured.agent).toBe(frozen.agent);
  });

  it('显式 agent 覆盖进入计划，缺省沿用冻结 agent 而不解析当前默认值', () => {
    const repoPath = repoWithProfile({
      commands: { build: { tool: 'npm', args: ['run', 'build'] } },
    });
    const frozen = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const switched = recaptureRunPlan({
      repoPath,
      frozenPlan: frozen,
      agent: 'codex',
    });
    expect(switched.agent).toBe('codex');
    expect(switched.digest).not.toBe(frozen.digest);
    // 不传 agent：即使外部默认配置变化也保持冻结身份。
    expect(recaptureRunPlan({ repoPath, frozenPlan: frozen }).agent).toBe(
      'mock',
    );
  });

  it('保留冻结计划的运行上下文（mode/profile/超时/templateId）', () => {
    const repoPath = repoWithProfile({
      commands: { build: { tool: 'npm', args: ['run', 'build'] } },
    });
    const frozen = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
      profile: 'cli',
      allowDirtyBase: true,
      timeoutMs: 12345,
      templateId: 'rebind-fixture',
    });
    const recaptured = recaptureRunPlan({ repoPath, frozenPlan: frozen });
    expect(recaptured.mode).toBe('workflow');
    expect(recaptured.profile).toBe('cli');
    expect(recaptured.allowDirtyBase).toBe(true);
    expect(recaptured.timeoutMs).toBe(12345);
    expect(recaptured.templateId).toBe('rebind-fixture');
  });
});

describe('PD-05 diffRunBindings', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function repoWithProfile(profile: unknown): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-rebind-diff-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(
      join(repoPath, '.tekon', 'repo-profile.yaml'),
      JSON.stringify(profile),
    );
    return repoPath;
  }

  function spec() {
    return parseWorkflowTemplate({
      id: 'diff-fixture',
      governance: 'none',
      phases: [
        {
          id: 'dev',
          nodes: [
            {
              id: 'rd',
              role: 'rd',
              gates: [{ type: 'build', commandRef: 'build' }],
            },
          ],
        },
      ],
    });
  }

  function provider(
    overrides: Partial<RunProviderConfig> = {},
  ): RunProviderConfig {
    return {
      runId: 'run_1',
      provider: 'mock',
      configSummary: { provider: 'mock' },
      createdAt: '2026-11-17T00:00:00.000Z',
      ...overrides,
    };
  }

  it('计划与 provider 快照都未变时报告无差异', () => {
    const repoPath = repoWithProfile({
      commands: { build: { tool: 'npm', args: ['run', 'build'] } },
    });
    const frozen = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const current = recaptureRunPlan({ repoPath, frozenPlan: frozen });
    const snapshot = provider();
    const diff = diffRunBindings({
      frozenPlan: frozen,
      currentPlan: current,
      frozenProvider: snapshot,
      currentProvider: snapshot,
    });
    expect(diff.hasDifferences).toBe(false);
    expect(diff.agent).toBeNull();
    expect(diff.provider).toBeNull();
    expect(diff.repoCommands).toEqual([]);
  });

  it('报告 repoCommands 的 missing→resolved 差异并带 commandRef', () => {
    const missingRepo = repoWithProfile({ commands: {} });
    const frozen = captureRunPlan(missingRepo, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const fixedRepo = repoWithProfile({
      commands: { build: { tool: 'npm', args: ['run', 'build'] } },
    });
    const current = recaptureRunPlan({
      repoPath: fixedRepo,
      frozenPlan: frozen,
    });
    const snapshot = provider();
    const diff = diffRunBindings({
      frozenPlan: frozen,
      currentPlan: current,
      frozenProvider: snapshot,
      currentProvider: snapshot,
    });
    expect(diff.hasDifferences).toBe(true);
    expect(diff.repoCommands).toHaveLength(1);
    expect(diff.repoCommands[0]?.commandRef).toBe('build');
    expect(diff.repoCommands[0]?.frozen.status).toBe('missing');
    expect(diff.repoCommands[0]?.current.status).toBe('resolved');
  });

  it('区分 provider 名称切换与同 provider 配置变化', () => {
    const repoPath = repoWithProfile({
      commands: { build: { tool: 'npm', args: ['run', 'build'] } },
    });
    const frozen = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const current = recaptureRunPlan({ repoPath, frozenPlan: frozen });

    const switched = diffRunBindings({
      frozenPlan: frozen,
      currentPlan: current,
      frozenProvider: provider(),
      currentProvider: provider({
        provider: 'codex',
        configSummary: { provider: 'codex' },
      }),
    });
    expect(switched.provider).toEqual({
      fromProvider: 'mock',
      toProvider: 'codex',
      configChanged: true,
    });

    // 仅名称不同、摘要完全相同（理论边缘情况）：configChanged 为 false，
    // 但 provider 差异仍成立。
    const nameOnly = diffRunBindings({
      frozenPlan: frozen,
      currentPlan: current,
      frozenProvider: provider(),
      currentProvider: provider({ provider: 'codex' }),
    });
    expect(nameOnly.provider).toEqual({
      fromProvider: 'mock',
      toProvider: 'codex',
      configChanged: false,
    });

    const reconfigured = diffRunBindings({
      frozenPlan: frozen,
      currentPlan: current,
      frozenProvider: provider(),
      currentProvider: provider({
        configSummary: { provider: 'mock', profile: 'internal' },
      }),
    });
    expect(reconfigured.provider).toEqual({
      fromProvider: 'mock',
      toProvider: 'mock',
      configChanged: true,
    });
  });

  it('报告 agent 切换差异', () => {
    const repoPath = repoWithProfile({
      commands: { build: { tool: 'npm', args: ['run', 'build'] } },
    });
    const frozen = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const current = recaptureRunPlan({
      repoPath,
      frozenPlan: frozen,
      agent: 'codex',
    });
    const snapshot = provider();
    const diff = diffRunBindings({
      frozenPlan: frozen,
      currentPlan: current,
      frozenProvider: snapshot,
      currentProvider: snapshot,
    });
    expect(diff.agent).toEqual({ from: 'mock', to: 'codex' });
    expect(diff.hasDifferences).toBe(true);
  });
});

describe('PD-05 inspectCurrentBinding', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function repoWithProfile(profile: unknown): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-rebind-inspect-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.tekon'), { recursive: true });
    writeFileSync(
      join(repoPath, '.tekon', 'repo-profile.yaml'),
      JSON.stringify(profile),
    );
    return repoPath;
  }

  function spec() {
    return parseWorkflowTemplate({
      id: 'inspect-fixture',
      governance: 'none',
      phases: [
        {
          id: 'dev',
          nodes: [
            {
              id: 'rd',
              role: 'rd',
              gates: [{ type: 'build', commandRef: 'build' }],
            },
          ],
        },
      ],
    });
  }

  const snapshot: RunProviderConfig = {
    runId: 'run_1',
    provider: 'mock',
    configSummary: { provider: 'mock' },
    createdAt: '2026-11-17T00:00:00.000Z',
  };

  it('只读探测到 profile 修复产生的 repoCommands 差异，provider 段保持 null', () => {
    const missingRepo = repoWithProfile({ commands: {} });
    const frozen = captureRunPlan(missingRepo, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const fixedRepo = repoWithProfile({
      commands: { build: { tool: 'npm', args: ['run', 'build'] } },
    });
    const diff = inspectCurrentBinding({
      repoPath: fixedRepo,
      frozenPlan: frozen,
      frozenProvider: snapshot,
    });
    expect(diff.hasDifferences).toBe(true);
    expect(diff.repoCommands).toHaveLength(1);
    expect(diff.repoCommands[0]?.frozen.status).toBe('missing');
    expect(diff.repoCommands[0]?.current.status).toBe('resolved');
    // 只读路径不构建新引擎，provider 身份无从比较。
    expect(diff.provider).toBeNull();
    expect(diff.agent).toBeNull();
  });

  it('配置未变时报告无差异', () => {
    const repoPath = repoWithProfile({
      commands: { build: { tool: 'npm', args: ['run', 'build'] } },
    });
    const frozen = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const diff = inspectCurrentBinding({
      repoPath,
      frozenPlan: frozen,
      frozenProvider: snapshot,
    });
    expect(diff.hasDifferences).toBe(false);
  });
});
