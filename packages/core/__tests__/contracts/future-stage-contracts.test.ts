import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
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

// ---------------------------------------------------------------------------
// Refactor acceptance-line contracts that belong to later stages.
//
// Each remaining case is an `it.fails` placeholder: the setup steps run
// against the current code and succeed; only the final contract assertion
// fails, documenting the capability a later batch must deliver. When the
// capability lands, the placeholder goes green by itself and must be
// converted into a normal regression test (and strengthened into the
// real-process e2e named in the refactor plan). Do not delete these to make
// a run green. Contract 4 (reviewer/gate optional) was delivered in PD-06
// subitem 4 and converted to a normal test; contract 6 (human rejection
// rework) was delivered in PD-18 and now lives as the strengthened e2e
// __tests__/workflow/human-rejection-rework.e2e.test.ts. Contract 5
// (role model selection) remains for batch 10.
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

  // Contract 5 (refactor plan, stage 2): custom-role prompt, model and tool
  // configuration reach the provider; when a driver cannot honor the model
  // selection, startup fails explicitly (PD-10).
  it.fails('contract 5 (stage 2): a role-selected model is loaded for the provider', () => {
    const repoPath = createGitRepo();
    const rolesRoot = mkdtempSync(join(tmpdir(), 'tekon-contract-roles-'));
    tempDirs.push(rolesRoot);
    const roleDir = join(rolesRoot, 'rd');
    // Setup: write a role whose agent.yaml carries a model selection. The
    // current schema is non-strict, so loading succeeds and strips the key.
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

    // Contract assertion (fails today): the model selection survives parsing
    // and is available to hand to the provider adapter.
    expect((loaded.agent as { model?: string }).model).toBe('claude-opts-5-5');
  });

});
