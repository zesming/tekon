import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createAuditLogger,
  createCommandGateway,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  createWorktreeManager,
  migrateDatabase,
  openTekonDatabase,
  type GateEngine,
} from '../../src/index.js';

describe('workflow engine changes-requested rework e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it(
    'runs full rework cycle when independent-review returns changes-requested: ' +
      'target node transitions passed → needs-revision → running → awaiting-gate → passed, ' +
      'rework node is created and executed, ' +
      'target gates run in rework worktree and are force-rerun, ' +
      'lease aliases are cleaned up, and no double passed → passed transitions occur',
    async () => {
      const repoPath = createGitRepo(tempDirs);
      const db = openTekonDatabase({ filename: ':memory:' });
      migrateDatabase(db);
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const gateway = createCommandGateway({ repositories });
      const mock = createMockAgentAdapter();

      const observedGateCalls: Array<{
        nodeId: string;
        gateType: string;
        cwd: string;
      }> = [];

      const engine = createWorkflowEngine({
        repoPath,
        dataDir: '.tekon',
        repositories,
        audit,
        adapter: {
          async runAgent(input) {
            if (input.runContext.nodeId.endsWith('rd-node')) {
              writeFileSync(
                join(input.runContext.repoPath, 'feature.txt'),
                'implemented\n',
                'utf8',
              );
            }
            return mock.runAgent(input);
          },
        },
        gateEngine: createChangesRequestedGateEngine(
          repositories,
          observedGateCalls,
        ),
        worktreeManager: createWorktreeManager({ repositories, gateway }),
      });

      const result = await engine.startRun({
        demandText: 'changes-requested rework 测试',
        mode: 'template',
        workflowSpec: {
          id: 'bugfix-rework',
          name: 'Bugfix Rework',
          version: 1,
          retryPolicy: {
            maxAttempts: 2,
            maxRetries: 1,
            backoffMs: 0,
            strategy: 'fixed',
            onExhausted: 'block',
          },
          phases: [
            {
              id: 'implementation',
              name: 'Implementation',
              dependsOn: [],
              parallel: false,
              nodes: [
                {
                  id: 'rd-node',
                  role: 'rd',
                  inputs: [],
                  outputs: [{ id: 'code', type: 'code-changes' }],
                  gates: [
                    {
                      type: 'build',
                      requiresHumanApproval: false,
                      maxRetries: 0,
                      retryPolicy: {
                        maxRetries: 0,
                        maxAttempts: 1,
                        backoffMs: 0,
                        strategy: 'fixed',
                        onExhausted: 'block',
                      },
                    },
                  ],
                  dependsOn: [],
                },
              ],
            },
            {
              id: 'review',
              name: 'Review',
              dependsOn: ['implementation'],
              parallel: false,
              nodes: [
                {
                  id: 'reviewer-node',
                  role: 'reviewer',
                  inputs: [{ id: 'code', type: 'code-changes', fromNodeId: 'rd-node' }],
                  outputs: [{ id: 'review', type: 'code-review' }],
                  gates: [
                    {
                      type: 'independent-review',
                      requiresHumanApproval: false,
                      maxRetries: 1,
                      retryPolicy: {
                        maxRetries: 1,
                        maxAttempts: 2,
                        backoffMs: 0,
                        strategy: 'fixed',
                        onExhausted: 'block',
                      },
                    },
                  ],
                  dependsOn: ['rd-node'],
                },
              ],
            },
            {
              id: 'delivery',
              name: 'Delivery',
              dependsOn: ['review'],
              parallel: false,
              nodes: [
                {
                  id: 'pmo-node',
                  role: 'pmo',
                  inputs: [],
                  outputs: [],
                  gates: [],
                  dependsOn: [],
                },
              ],
            },
          ],
        },
      });

      // ── Overall: workflow passed ──
      expect(result.workflow.status).toBe('passed');

      // ── Rework node was created ──
      const nodes = await repositories.listNodes(result.runId);
      const reworkNodes = nodes.filter((node) =>
        /_rework_\d+$/u.test(node.id),
      );
      expect(reworkNodes).toHaveLength(1);

      // ── Independent-review gate: one failed (changes-requested) + one passed ──
      const gateResults = await repositories.listGateResults(result.runId);
      const reviewGates = gateResults.filter(
        (g) => g.gateType === 'independent-review',
      );
      expect(reviewGates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            status: 'failed',
            failureClassification: 'changes-requested',
          }),
          expect.objectContaining({ status: 'passed' }),
        ]),
      );

      // ── Build gate ran at least twice (initial + force-rerun during rework) ──
      const buildGates = gateResults.filter((g) => g.gateType === 'build');
      expect(buildGates.length).toBeGreaterThanOrEqual(2);
      expect(buildGates.every((g) => g.status === 'passed')).toBe(true);

      // ── Target gates ran in worktree (not repoPath) during rework ──
      const buildInWorktree = observedGateCalls.filter(
        (call) =>
          call.gateType === 'build' &&
          call.cwd.includes(join('.tekon', 'worktrees')) &&
          call.cwd !== repoPath,
      );
      expect(buildInWorktree.length).toBeGreaterThanOrEqual(1);

      // ── No passed → passed double transition for any node ──
      const auditEvents = await repositories.listAuditEvents(result.runId);
      const doublePasses = auditEvents.filter(
        (event) =>
          event.type.startsWith('workflow.node.') &&
          (event.payload as { from?: string } | null)?.from === 'passed' &&
          (event.payload as { to?: string } | null)?.to === 'passed',
      );
      expect(doublePasses).toHaveLength(0);

      // ── Lease aliases cleaned up: all worktree leases released ──
      const leases = await repositories.listWorktreeLeases(result.runId);
      expect(leases.length).toBeGreaterThanOrEqual(2);
      expect(leases.every((lease) => lease.releasedAt)).toBe(true);

      // ── Git delivery branch has the file ──
      expect(
        execFileSync(
          'git',
          ['show', `tekon-delivery/${result.runId}:feature.txt`],
          { cwd: repoPath, encoding: 'utf8' },
        ),
      ).toBe('implemented\n');

      db.close();
    },
  );
});

/**
 * Custom gate engine for the changes-requested rework test.
 *
 * - `independent-review` returns `failed` with `failureClassification:
 *   'changes-requested'` on the **first** call per node, then `passed` on
 *   every subsequent call (simulating "reviewer approved after rework").
 * - All other gate types always return `passed`.
 * - Records every call into `observedCalls` for cwd / gate-type assertions.
 */
function createChangesRequestedGateEngine(
  repositories: ReturnType<typeof createRepositories>,
  observedCalls: Array<{ nodeId: string; gateType: string; cwd: string }>,
): GateEngine {
  const reviewCallsByNode = new Map<string, number>();

  return {
    async runGate(input) {
      observedCalls.push({
        nodeId: input.nodeId,
        gateType: input.gate.type,
        cwd: input.cwd,
      });

      let shouldFailChangesRequested = false;
      if (input.gate.type === 'independent-review') {
        const count = (reviewCallsByNode.get(input.nodeId) ?? 0) + 1;
        reviewCallsByNode.set(input.nodeId, count);
        shouldFailChangesRequested = count === 1;
      }

      const idSuffix = `${input.gate.type}_${input.nodeId}_${Date.now()}`;
      return repositories.recordGateResult({
        id: `gate_${idSuffix}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        gateKey: input.gate.gateKey,
        status: shouldFailChangesRequested ? 'failed' : 'passed',
        failureClassification: shouldFailChangesRequested
          ? 'changes-requested'
          : null,
        durationMs: 0,
        retries: 0,
        createdAt: new Date().toISOString(),
      });
    },

    async createAutoFixRepairNode(input) {
      return repositories.createNode({
        id: `repair_${input.failedGateResult.id}`,
        runId: input.failedGateResult.runId,
        role: input.fixerRole,
        status: 'pending',
        gates: [],
        dependencies: [input.failedGateResult.nodeId],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
    },
  };
}

/** Initialise a bare git repo with one commit so worktree leasing works. */
function createGitRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-rework-'));
  tempDirs.push(repoPath);
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
    cwd: repoPath,
  });
  execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
    cwd: repoPath,
  });
  writeFileSync(join(repoPath, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
  return repoPath;
}
