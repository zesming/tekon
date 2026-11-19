import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  captureRunPlan,
  parseWorkflowTemplate,
  type RunProviderConfig,
  type WorkflowInstance,
} from '@tekon/core';
import {
  formatBindingDiff,
  inspectRunBinding,
  loadFrozenV3Plan,
} from '../src/lib/binding-diff.js';

describe('CLI binding diff helper', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  function repoWithProfile(profile: unknown): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-cli-binding-'));
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
      id: 'cli-binding',
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

  const provider: RunProviderConfig = {
    runId: 'run_1',
    provider: 'mock',
    configSummary: { provider: 'mock' },
    createdAt: '2026-11-17T00:00:00.000Z',
  };

  function workflowWith(snapshot: string | null): WorkflowInstance {
    return {
      id: 'run_1',
      projectId: 'proj_1',
      demandId: 'demand_1',
      status: 'blocked',
      ...(snapshot ? { planSnapshot: snapshot } : {}),
      createdAt: '2026-11-17T00:00:00.000Z',
      updatedAt: '2026-11-17T00:00:00.000Z',
    } as WorkflowInstance;
  }

  it('loads a frozen v3 plan and rejects legacy/absent snapshots with null', () => {
    const repoPath = repoWithProfile({
      commands: { build: { tool: 'git', args: ['--version'] } },
    });
    const plan = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    expect(loadFrozenV3Plan(workflowWith(JSON.stringify(plan)))?.digest).toBe(
      plan.digest,
    );
    expect(loadFrozenV3Plan(workflowWith(null))).toBeNull();
    expect(
      loadFrozenV3Plan(workflowWith(JSON.stringify({ digestVersion: 1 }))),
    ).toBeNull();
  });

  it('detects the repaired profile command and renders readable hint lines', () => {
    const blockedRepo = repoWithProfile({ commands: {} });
    const plan = captureRunPlan(blockedRepo, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const fixedRepo = repoWithProfile({
      commands: { build: { tool: 'git', args: ['--version'] } },
    });
    const diff = inspectRunBinding({
      repoPath: fixedRepo,
      workflow: workflowWith(JSON.stringify(plan)),
      frozenProvider: provider,
    });
    expect(diff?.hasDifferences).toBe(true);
    const lines = formatBindingDiff(diff!);
    expect(lines.join('\n')).toContain('commands.build');
    expect(lines.join('\n')).toContain('missing');
    expect(lines.join('\n')).toContain('resolved');
  });

  it('renders agent and provider changes', () => {
    const repoPath = repoWithProfile({
      commands: { build: { tool: 'git', args: ['--version'] } },
    });
    const plan = captureRunPlan(repoPath, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const lines = formatBindingDiff({
      hasDifferences: true,
      agent: { from: 'mock', to: 'codex' },
      provider: {
        fromProvider: 'mock',
        toProvider: 'codex',
        configChanged: true,
      },
      repoCommands: [],
    });
    expect(lines).toContain('  agent: mock → codex');
    expect(lines.join('\n')).toContain('provider: mock → codex');
    // 引用 plan 避免未使用告警，同时保证夹具仍可构造。
    expect(plan.digest).toBeTruthy();
  });

  it('returns null when the run carries no frozen v3 snapshot', () => {
    const repoPath = repoWithProfile({ commands: {} });
    expect(
      inspectRunBinding({
        repoPath,
        workflow: workflowWith(null),
        frozenProvider: provider,
      }),
    ).toBeNull();
  });

  it('returns null instead of throwing when the current profile is unreadable', () => {
    const validRepo = repoWithProfile({
      commands: { build: { tool: 'git', args: ['--version'] } },
    });
    const plan = captureRunPlan(validRepo, spec(), {
      agent: 'mock',
      mode: 'workflow',
    });
    const brokenRepo = repoWithProfile({});
    writeFileSync(
      join(brokenRepo, '.tekon', 'repo-profile.yaml'),
      'PRIVATE_BROKEN_PROFILE: [',
    );
    expect(
      inspectRunBinding({
        repoPath: brokenRepo,
        workflow: workflowWith(JSON.stringify(plan)),
        frozenProvider: provider,
      }),
    ).toBeNull();
  });
});
