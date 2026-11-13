import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createHumanGate,
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
// Every case here is an `it.fails` placeholder: the setup steps run against
// the current code and succeed; only the final contract assertion fails,
// documenting the capability stage 2 must deliver. When the capability lands,
// the placeholder goes green by itself and must be converted into a normal
// regression test (and strengthened into the real-process e2e named in the
// refactor plan). Do not delete these to make a run green.
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
  // Contract 4 (refactor plan, stage 2): a minimal custom YAML workflow is
  // created and runs to completion with queryable node status, and reviewer
  // nodes/gates become optional product behavior instead of requiring the
  // `governance: none` escape hatch (PD-06).
  it.fails('contract 4 (stage 2): accepts a minimal template without reviewer or governance override', () => {
    // Setup: the YAML itself parses as a raw template object today. The node
    // carries build/lint gates so structural gate validation passes and the
    // only blocker is the reviewer requirement.
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
    expect(raw.phases).toHaveLength(1);

    // Contract assertion (fails today): reviewer-less templates must validate
    // without setting governance: 'none'. Current code throws
    // "Workflow template must include a reviewer node".
    const template = parseWorkflowTemplate(raw);
    expect(template.phases[0]!.nodes[0]!.id).toBe('only-node');
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

  // Contract 6 (refactor plan, stage 2): a human rejection carries the note
  // back to the agent, re-runs the target node, and opens a fresh approval.
  it.fails('contract 6 (stage 2): rejection re-runs the target node and opens a new approval', async () => {
    const repoPath = createGitRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      agentProvider: 'mock',
      adapter: createMockAgentAdapter(),
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    // Setup: run to a human gate and reject with a note — both work today.
    const result = await engine.startRun({
      demandText: 'rejection rework contract',
      mode: 'template',
      workflowSpec: {
        id: 'reject-contract',
        name: 'reject-contract',
        version: 1,
        retryPolicy: {
          maxAttempts: 1,
          maxRetries: 0,
          backoffMs: 0,
          strategy: 'fixed' as const,
          onExhausted: 'block' as const,
        },
        phases: [
          {
            id: 'rd',
            name: 'RD',
            dependsOn: [],
            parallel: false,
            nodes: [
              {
                id: 'rd-node',
                role: 'rd' as const,
                inputs: [],
                outputs: [{ id: 'code', type: 'code-changes' as const }],
                gates: [{ type: 'human', requiresHumanApproval: true }],
                dependsOn: [],
              },
            ],
          },
        ],
      },
    });
    expect(result.workflow.status).toBe('paused');
    const [decision] = await repositories.listHumanDecisions(result.runId);
    expect(decision).toBeTruthy();
    await createHumanGate({ repositories }).rejectHumanGate(
      decision!.id,
      'contract-reviewer',
      '请按备注返工',
    );

    // Contract assertion (fails today): rejection starts a rework loop — the
    // target node re-runs and a fresh pending decision becomes available.
    // Current behavior blocks the node without any new decision.
    const pendingAfterReject = (
      await repositories.listHumanDecisions(result.runId)
    ).filter((entry) => entry.status === 'pending');
    expect(pendingAfterReject).toHaveLength(1);
    db.close();
  });
});
