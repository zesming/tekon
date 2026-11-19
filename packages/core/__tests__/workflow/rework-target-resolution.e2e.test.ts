import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
  type AgentAdapter,
  type AgentRunInput,
  type GateEngine,
} from '../../src/index.js';

// CD-14：返工目标必须直读评审产物 reviewProcess.targetNodeId（gate 已校验
// 连通性与类型），删除"最后一个 passed 节点"启发式；反馈必须携带 body 与
// findings，而不是固定英文句。code-review 不在旧白名单内，是最稳定的
// 红测载体：旧实现必然落到启发式。
describe('CD-14 rework target resolution e2e', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  function createRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-rework-target-'));
    tempDirs.push(repoPath);
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'tekon@example.com'], {
      cwd: repoPath,
    });
    execFileSync('git', ['config', 'user.name', 'Tekon Test'], {
      cwd: repoPath,
    });
    writeFileSync(join(repoPath, 'README.md'), 'fixture\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });
    return repoPath;
  }

  function workflowSpec() {
    return {
      id: 'rework-target',
      name: 'Rework Target',
      version: 1,
      retryPolicy: {
        maxAttempts: 2,
        maxRetries: 1,
        backoffMs: 0,
        strategy: 'fixed' as const,
        onExhausted: 'block' as const,
      },
      phases: [
        {
          id: 'implementation',
          name: 'Implementation',
          dependsOn: [],
          nodes: [
            {
              id: 'pm-node',
              role: 'pm',
              inputs: [],
              outputs: [{ id: 'prd', type: 'prd' }],
              gates: [],
              dependsOn: [],
            },
            {
              id: 'rd-node',
              role: 'rd',
              inputs: [{ id: 'prd', type: 'prd', fromNodeId: 'pm-node' }],
              outputs: [{ id: 'code', type: 'code-changes' }],
              gates: [],
              dependsOn: ['pm-node'],
            },
          ],
        },
        {
          id: 'review',
          name: 'Review',
          dependsOn: ['implementation'],
          nodes: [
            {
              id: 'reviewer-node',
              role: 'reviewer',
              inputs: [
                { id: 'code', type: 'code-changes', fromNodeId: 'rd-node' },
              ],
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
                    strategy: 'fixed' as const,
                    onExhausted: 'block' as const,
                  },
                },
              ],
              dependsOn: ['rd-node'],
            },
          ],
        },
      ],
    };
  }

  /** Reviewer adapter: first run writes a code-review artifact with explicit
   *  reviewProcess.targetNodeId pointing at pm-node (the FIRST passed node).
   *  The deleted heuristic would instead pick rd-node (last passed node). */
  function reviewerAdapter(options: {
    explicitTarget: string | null;
    findingMessage?: string;
    capturedPrompts?: Array<{ nodeId: string; prompt: string }>;
  }): AgentAdapter {
    const mock = createMockAgentAdapter();
    const requested = new Set<string>();
    return {
      ...mock,
      async runAgent(input: AgentRunInput) {
        options.capturedPrompts?.push({
          nodeId: input.runContext.nodeId,
          prompt: input.prompt,
        });
        const isReviewer = input.runContext.nodeId.endsWith('_reviewer-node');
        if (!isReviewer || requested.has(input.runContext.nodeId)) {
          return mock.runAgent(input);
        }
        requested.add(input.runContext.nodeId);
        const store = input.artifactStore!;
        return mock.runAgent({
          ...input,
          artifactStore: {
            ...store,
            async writeArtifact(artifact) {
              if (artifact.type !== 'code-review') {
                return store.writeArtifact(artifact);
              }
              const payload = JSON.parse(artifact.content) as Record<
                string,
                unknown
              >;
              if (options.explicitTarget === null) {
                delete payload.reviewProcess;
              } else {
                payload.reviewProcess = {
                  ...(payload.reviewProcess as object),
                  targetNodeId: `${input.runContext.runId}_${options.explicitTarget}`,
                };
              }
              payload.decision = 'changes-requested';
              payload.findings = [
                {
                  severity: 'important',
                  message:
                    options.findingMessage ??
                    'FINDING-MARKER: pm-node must cover the empty-input boundary.',
                },
              ];
              return store.writeArtifact({
                ...artifact,
                content: JSON.stringify(payload),
              });
            },
          },
        });
      },
    };
  }

  function changesRequestedOnceGateEngine(
    repositories: ReturnType<typeof createRepositories>,
  ): GateEngine {
    const callsByNode = new Map<string, number>();
    return {
      async runGate(input) {
        const count = (callsByNode.get(input.nodeId) ?? 0) + 1;
        callsByNode.set(input.nodeId, count);
        const shouldFail =
          input.gate.type === 'independent-review' && count === 1;
        return repositories.recordGateResult({
          id: `gate_${input.gate.type}_${input.nodeId}_${Date.now()}_${count}`,
          runId: input.runId,
          nodeId: input.nodeId,
          gateType: input.gate.type,
          gateKey: input.gate.gateKey,
          status: shouldFail ? 'failed' : 'passed',
          failureClassification: shouldFail ? 'changes-requested' : null,
          durationMs: 0,
          retries: 0,
          createdAt: new Date().toISOString(),
        });
      },
    };
  }

  async function startEngine(input: {
    adapter: AgentAdapter;
    repoPath: string;
    repositories: ReturnType<typeof createRepositories>;
    audit: ReturnType<typeof createAuditLogger>;
    gateway: ReturnType<typeof createCommandGateway>;
  }) {
    const engine = createWorkflowEngine({
      repoPath: input.repoPath,
      dataDir: '.tekon',
      repositories: input.repositories,
      audit: input.audit,
      agentProvider: 'mock',
      adapter: input.adapter,
      gateEngine: changesRequestedOnceGateEngine(input.repositories),
      worktreeManager: createWorktreeManager({
        repositories: input.repositories,
        gateway: input.gateway,
      }),
    });
    return engine.startRun({
      demandText: 'CD-14 返工目标直读',
      mode: 'template',
      workflowSpec: workflowSpec(),
    });
  }

  it('reworks the explicit reviewProcess.targetNodeId even when the heuristic would pick another node', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });
    const prompts: Array<{ nodeId: string; prompt: string }> = [];

    const result = await startEngine({
      repoPath,
      repositories,
      audit,
      gateway,
      adapter: reviewerAdapter({
        explicitTarget: 'pm-node',
        capturedPrompts: prompts,
      }),
    });

    try {
      expect(result.workflow.status).toBe('passed');
      const nodes = await repositories.listNodes(result.runId);
      const reworkNodes = nodes.filter((node) => /_rework_\d+_/u.test(node.id));
      expect(reworkNodes).toHaveLength(1);
      // 显式目标 pm-node；启发式会错选 rd-node。
      expect(reworkNodes[0]!.id).toContain('pm-node_rework_');
      expect(reworkNodes[0]!.id).not.toContain('rd-node');

      const reworkPrompt = prompts.find((entry) =>
        entry.prompt.includes('Review Feedback'),
      )?.prompt;
      expect(reworkPrompt).toBeDefined();
      expect(reworkPrompt!).toContain(
        'FINDING-MARKER: pm-node must cover the empty-input boundary.',
      );
    } finally {
      db.close();
    }
  }, 120_000);

  it('blocks without creating rework nodes when the review artifact carries no targetNodeId (no heuristic fallback)', async () => {
    const repoPath = createRepo();
    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const gateway = createCommandGateway({ repositories });

    const result = await startEngine({
      repoPath,
      repositories,
      audit,
      gateway,
      adapter: reviewerAdapter({ explicitTarget: null }),
    });

    try {
      expect(result.workflow.status).toBe('blocked');
      const nodes = await repositories.listNodes(result.runId);
      expect(nodes.some((node) => /_rework_\d+_/u.test(node.id))).toBe(false);
      const events = await repositories.listAuditEvents(result.runId);
      expect(events.some((event) => event.type === 'gate.failed')).toBe(true);
      expect(events.some((event) => event.type === 'gate.rework.attempt')).toBe(
        false,
      );
    } finally {
      db.close();
    }
  }, 120_000);
});
