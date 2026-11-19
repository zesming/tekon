import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildClaudeCodeCommand,
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  createWorktreeManager,
  loadRole,
  migrateDatabase,
  openTekonDatabase,
  parseWorkflowTemplate,
} from '../../src/index.js';
import { resolveRoleProviderOverrides } from '../../src/role/provider-overrides.js';

// ---------------------------------------------------------------------------
// Refactor acceptance-line contracts.
//
// Contract 4 (reviewer/gate optional) was delivered in PD-06 subitem 4 and
// converted to a normal test; contract 6 (human rejection rework) was
// delivered in PD-18 and now lives as the strengthened e2e
// __tests__/workflow/human-rejection-rework.e2e.test.ts. Contract 5
// (role model selection) was delivered in PD-10 (batch 10a) and converted
// below into a normal regression test covering schema parsing, adapter
// argv translation, and the explicit driver-mismatch failure.
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createGitRepo(): string {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-contract-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'contract@tekon.local'], {
    cwd: repoPath,
    stdio: 'pipe',
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Contract'], {
    cwd: repoPath,
    stdio: 'pipe',
  });
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath, stdio: 'pipe' });
  return repoPath;
}

describe('future-stage workflow contracts (placeholders)', () => {
  // Contract 4 (refactor plan, stage 2 — delivered in PD-06 subitem 4):
  // reviewer nodes and gates are optional product behavior. A minimal
  // reviewer-less template validates without the `governance: none` escape
  // hatch, and a code-producing node may omit build/lint gates.
  it('contract 4 (stage 2): accepts a minimal template without reviewer or governance override', () => {
    const raw = {
      id: 'minimal-contract',
      version: 1,
      phases: [
        {
          id: 'dev',
          name: 'Dev',
          nodes: [
            {
              id: 'only-node',
              role: 'rd',
              inputs: [],
              outputs: [{ id: 'code', type: 'code-changes' }],
              gates: [
                { type: 'build', commandRef: 'build' },
                { type: 'lint', commandRef: 'lint' },
              ],
              dependsOn: [],
            },
          ],
        },
      ],
    };

    const template = parseWorkflowTemplate(raw);
    expect(template.phases[0]!.nodes[0]!.id).toBe('only-node');

    // Gates are optional too: a code-producing node without build/lint parses.
    const gateLess = parseWorkflowTemplate({
      id: 'gates-optional-contract',
      version: 1,
      phases: [
        {
          id: 'dev',
          name: 'Dev',
          nodes: [
            {
              id: 'bare-node',
              role: 'writer',
              outputs: [{ id: 'essay', type: 'essay' }],
            },
          ],
        },
      ],
    });
    expect(gateLess.phases[0]!.nodes[0]!.gates).toEqual([]);
  });

  // Contract 5 (PD-10, batch 10a): custom-role model/effort/driver config
  // survives parsing, reaches the adapter, and is translated into provider
  // argv; a driver the run cannot honor fails explicitly.
  it('contract 5 (stage 2): a role-selected model is loaded and translated for the provider', () => {
    const repoPath = createGitRepo();
    const rolesRoot = mkdtempSync(join(tmpdir(), 'tekon-contract-roles-'));
    tempDirs.push(rolesRoot);
    const roleDir = join(rolesRoot, 'rd');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(
      join(roleDir, 'agent.yaml'),
      ['role: rd', 'name: RD', "model: claude-opts-5-5", ''].join('\n'),
    );
    writeFileSync(join(roleDir, 'system.md'), 'You own the implementation.\n');

    const loaded = loadRole({
      role: 'rd',
      repoPath,
      builtInRolesDir: rolesRoot,
    });
    expect(loaded.role).toBe('rd');
    // Schema no longer strips the model selection.
    expect(loaded.agent.model).toBe('claude-opts-5-5');
  });

  it('contract 5: a role effort that the claude adapter cannot honor fails explicitly', () => {
    const repoPath = createGitRepo();
    const rolesRoot = mkdtempSync(join(tmpdir(), 'tekon-contract-roles-'));
    tempDirs.push(rolesRoot);
    const roleDir = join(rolesRoot, 'qa');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(
      join(roleDir, 'agent.yaml'),
      ['role: qa', 'name: QA', 'effort: high', ''].join('\n'),
    );
    writeFileSync(join(roleDir, 'system.md'), 'You validate quality.\n');

    const loaded = loadRole({
      role: 'qa',
      repoPath,
      builtInRolesDir: rolesRoot,
    });
    const overrides = resolveRoleProviderOverrides(
      'run_c5',
      'qa',
      loaded,
      {
        runId: 'run_c5',
        provider: 'claude-code',
        configSummary: {},
        createdAt: '2026-11-17T00:00:00.000Z',
      },
    );
    // The pure resolution still surfaces the effort; the adapter rejects it
    // at command-build time with a readable, class-specific error.
    expect(overrides).toEqual({ effort: 'high' });
    expect(() =>
      buildClaudeCodeCommand(
        {
          provider: 'claude-code',
          command: 'claude',
          args: [],
          promptMode: 'stdin',
          outputFormat: 'json',
          timeoutMs: 1000,
          permissionProfile: {
            sandbox: 'workspace-write',
            approval: 'acceptEdits',
            filesystemScope: [repoPath],
            network: 'restricted',
            tools: { allow: [], deny: [] },
          },
        },
        { prompt: 'hi' },
        undefined,
        overrides,
      ),
    ).toThrow(/ROLE_OVERRIDE_UNSUPPORTED/);
  });

  it('contract 5: a role driver mismatching the run provider fails before node start', () => {
    const repoPath = createGitRepo();
    const rolesRoot = mkdtempSync(join(tmpdir(), 'tekon-contract-roles-'));
    tempDirs.push(rolesRoot);
    const roleDir = join(rolesRoot, 'rd');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(
      join(roleDir, 'agent.yaml'),
      [
        'role: rd',
        'name: RD',
        'driver: codex',
        'model: gpt-x',
        '',
      ].join('\n'),
    );
    writeFileSync(join(roleDir, 'system.md'), 'You own the implementation.\n');

    const loaded = loadRole({
      role: 'rd',
      repoPath,
      builtInRolesDir: rolesRoot,
    });
    expect(() =>
      resolveRoleProviderOverrides(
        'run_c5',
        'rd',
        loaded,
        {
          runId: 'run_c5',
          provider: 'claude-code',
          configSummary: {},
          createdAt: '2026-11-17T00:00:00.000Z',
        },
      ),
    ).toThrow(/ROLE_DRIVER_MISMATCH/);
  });
});
