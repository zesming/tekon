import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
  migrateDatabase,
  openTekonDatabase,
  type GateEngine,
} from '../../src/index.js';

describe('workflow engine worktree execution e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('leases real git worktrees, promotes passed node changes, and releases leases', async () => {
    const repoPath = createGitRepo(tempDirs);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const mock = createMockAgentAdapter();
    const observedAgentCwds: string[] = [];
    const observedGateCwds: string[] = [];

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: {
        async runAgent(input) {
          observedAgentCwds.push(input.runContext.repoPath);
          expect(input.worktreeLease.worktreePath).toContain(
            join('.tekon', 'worktrees'),
          );
          expect(existsSync(input.worktreeLease.worktreePath)).toBe(true);
          if (input.runContext.nodeId.endsWith('rd-node')) {
            writeFileSync(
              join(input.runContext.repoPath, 'feature.txt'),
              'implemented in rd\n',
              'utf8',
            );
          }
          if (input.runContext.nodeId.endsWith('qa-node')) {
            expect(
              readFileSync(
                join(input.runContext.repoPath, 'feature.txt'),
                'utf8',
              ),
            ).toBe('implemented in rd\n');
          }
          return mock.runAgent(input);
        },
      },
      gateEngine: createObservedGateEngine(repositories, observedGateCwds),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    const result = await engine.startRun({
      demandText: '在真实 worktree 中执行节点',
      mode: 'template',
      workflowSpec: {
        id: 'worktree-single-node',
        name: 'Worktree Single Node',
        version: 1,
        retryPolicy: {
          maxAttempts: 1,
          maxRetries: 0,
          backoffMs: 0,
          strategy: 'fixed',
          onExhausted: 'block',
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
                role: 'rd',
                inputs: [],
                outputs: [],
                gates: [{ type: 'test', command: { tool: 'npm', args: [] } }],
                dependsOn: [],
              },
              {
                id: 'qa-node',
                role: 'qa',
                inputs: [],
                outputs: [],
                gates: [{ type: 'test', command: { tool: 'npm', args: [] } }],
                dependsOn: ['rd-node'],
              },
            ],
          },
        ],
      },
    });

    expect(result.workflow.status).toBe('passed');
    expect(observedAgentCwds).toHaveLength(2);
    expect(observedAgentCwds[0]).toContain(join('.tekon', 'worktrees'));
    expect(observedAgentCwds[1]).toContain(join('.tekon', 'worktrees'));
    expect(observedGateCwds).toEqual(observedAgentCwds);
    const leases = await repositories.listWorktreeLeases(result.runId);
    expect(leases).toHaveLength(2);
    expect(leases.every((lease) => lease.releasedAt)).toBe(true);
    expect(
      execFileSync(
        'git',
        ['show', `tekon-delivery/${result.runId}:feature.txt`],
        {
          cwd: repoPath,
          encoding: 'utf8',
        },
      ),
    ).toBe('implemented in rd\n');
    expect(await repositories.listAuditEvents(result.runId)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'worktree.lease.created' }),
        expect.objectContaining({ type: 'worktree.lease.promoted' }),
        expect.objectContaining({ type: 'worktree.lease.released' }),
      ]),
    );
    db.close();
  });

  it('finalizes and releases a worktree after a human gate is approved on resume', async () => {
    const repoPath = createGitRepo(tempDirs);
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    let agentRuns = 0;

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: {
        async runAgent(input) {
          agentRuns += 1;
          writeFileSync(
            join(input.runContext.repoPath, 'human-approved.txt'),
            'waiting for approval\n',
            'utf8',
          );
          return createMockAgentAdapter().runAgent(input);
        },
      },
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    const result = await engine.startRun({
      demandText: 'human gate 后继续交付',
      mode: 'template',
      workflowSpec: singleNodeWorkflow({
        id: 'human-worktree',
        gates: [{ type: 'human', requiresHumanApproval: true }],
      }),
    });

    expect(result.workflow.status).toBe('paused');
    const [decision] = await repositories.listHumanDecisions(result.runId);
    expect(decision).toBeTruthy();
    await createHumanGate({ repositories }).approveHumanGate(
      decision!.id,
      'tester',
      'approved',
    );
    await repositories.recordGateResult({
      id: `gate_resume_${decision!.id}`,
      runId: result.runId,
      nodeId: decision!.nodeId,
      gateType: 'human',
      status: 'passed',
      durationMs: 0,
      retries: 0,
      createdAt: new Date().toISOString(),
    });
    await repositories.transitionNode(decision!.nodeId, 'awaiting-gate');

    const resumed = await createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      adapter: {
        async runAgent() {
          throw new Error('resume must not rerun the approved node agent');
        },
      },
      gateEngine: createGateEngine({ repositories, gateway }),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    }).resumeRun(result.runId);

    expect(resumed.workflow.status).toBe('passed');
    expect(agentRuns).toBe(1);
    expect(
      execFileSync(
        'git',
        ['show', `tekon-delivery/${result.runId}:human-approved.txt`],
        {
          cwd: repoPath,
          encoding: 'utf8',
        },
      ),
    ).toBe('waiting for approval\n');
    expect(
      (await repositories.listWorktreeLeases(result.runId)).every(
        (lease) => lease.releasedAt,
      ),
    ).toBe(true);
    db.close();
  });

  it('promotes repair worktree changes before rerunning a failed gate', async () => {
    const repoPath = createGitRepo(tempDirs);
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
      adapter: {
        async runAgent(input) {
          if (input.runContext.nodeId.includes('repair_')) {
            expect(
              readFileSync(
                join(input.runContext.repoPath, 'broken.txt'),
                'utf8',
              ),
            ).toBe('needs repair\n');
            writeFileSync(
              join(input.runContext.repoPath, 'fixed.txt'),
              'repaired\n',
              'utf8',
            );
          } else {
            writeFileSync(
              join(input.runContext.repoPath, 'broken.txt'),
              'needs repair\n',
              'utf8',
            );
          }
          return createMockAgentAdapter().runAgent(input);
        },
      },
      gateEngine: createRepairGateEngine(repositories),
      worktreeManager: createWorktreeManager({ repositories, gateway }),
    });

    const result = await engine.startRun({
      demandText: 'auto-fix 修复 worktree',
      mode: 'template',
      workflowSpec: singleNodeWorkflow({
        id: 'repair-worktree',
        gates: [
          {
            type: 'build',
            requiresHumanApproval: false,
            maxRetries: 1,
            retryPolicy: {
              maxRetries: 1,
              maxAttempts: 2,
              backoffMs: 0,
              strategy: 'fixed',
              onExhausted: 'block',
            },
            autoFix: true,
          },
        ],
      }),
    });

    expect(result.workflow.status).toBe('passed');
    expect(
      execFileSync(
        'git',
        ['show', `tekon-delivery/${result.runId}:fixed.txt`],
        {
          cwd: repoPath,
          encoding: 'utf8',
        },
      ),
    ).toBe('repaired\n');
    expect(
      (await repositories.listWorktreeLeases(result.runId)).every(
        (lease) => lease.releasedAt,
      ),
    ).toBe(true);
    db.close();
  });
});

function singleNodeWorkflow(input: {
  id: string;
  gates: Array<Record<string, unknown>>;
}) {
  return {
    id: input.id,
    name: input.id,
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
            outputs: [],
            gates: input.gates,
            dependsOn: [],
          },
        ],
      },
    ],
  };
}

function createObservedGateEngine(
  repositories: ReturnType<typeof createRepositories>,
  observedCwds: string[],
): GateEngine {
  let gateCounter = 0;
  return {
    async runGate(input) {
      gateCounter += 1;
      observedCwds.push(input.cwd);
      return repositories.recordGateResult({
        id: `gate_${input.nodeId}_${input.gate.type}_${gateCounter}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        status: 'passed',
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

function createRepairGateEngine(
  repositories: ReturnType<typeof createRepositories>,
): GateEngine {
  let gateCounter = 0;
  return {
    async runGate(input) {
      gateCounter += 1;
      const repaired = existsSync(join(input.cwd, 'fixed.txt'));
      return repositories.recordGateResult({
        id: `gate_${input.nodeId}_${input.gate.type}_${gateCounter}`,
        runId: input.runId,
        nodeId: input.nodeId,
        gateType: input.gate.type,
        status: repaired ? 'passed' : 'failed',
        durationMs: 0,
        retries: repaired ? 1 : 0,
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

function createGitRepo(tempDirs: string[]) {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-engine-worktree-'));
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
