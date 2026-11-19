import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { passthroughGateEngine } from '../helpers/passthrough-gate-engine.js';

import {
  createAuditLogger,
  createRepositories,
  createWorkflowEngine,
  migrateDatabase,
  openTekonDatabase,
  type AgentRunInput,
  type AgentRunResult,
} from '../../src/index.js';
import { planFromRepository } from '../../src/workflow/execution-plan.js';

// PD-06 子项 2：节点级 prompt 从模板经执行计划落库，并进入 agent 提示词。
describe('node-level prompt propagation (PD-06)', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('persists the node prompt and injects it into the agent prompt', async () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-node-prompt-repo-'));
    const rolesDir = mkdtempSync(join(tmpdir(), 'tekon-node-prompt-roles-'));
    tempDirs.push(repoPath, rolesDir);

    const writerDir = join(rolesDir, 'writer');
    mkdirSync(writerDir, { recursive: true });
    writeFileSync(
      join(writerDir, 'agent.yaml'),
      ['role: writer', 'name: Custom Writer'].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(writerDir, 'system.md'),
      'Writer system instructions.',
      'utf8',
    );

    const db = openTekonDatabase({ filename: ':memory:' });
    migrateDatabase(db);
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const prompts: string[] = [];

    const engine = createWorkflowEngine({
      repoPath,
      dataDir: '.tekon',
      repositories,
      audit,
      builtInRolesDir: rolesDir,
      agentProvider: 'mock',
      adapter: {
        async runAgent(input: AgentRunInput): Promise<AgentRunResult> {
          prompts.push(input.prompt);
          return {
            provider: 'custom',
            exitCode: 0,
            durationMs: 1,
            outputFiles: [],
            timedOut: false,
          };
        },
      },
      gateEngine: passthroughGateEngine(repositories),
    });

    const nodeInstruction = '用不超过 200 字总结本周客户反馈，按主题分组。';
    const result = await engine.startRun({
      demandText: '输出本周客户反馈摘要',
      mode: 'template',
      workflowSpec: {
        id: 'node-prompt-engine',
        name: 'Node Prompt Engine',
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
            id: 'writing',
            name: 'Writing',
            dependsOn: [],
            nodes: [
              {
                id: 'summary-node',
                role: 'writer',
                prompt: nodeInstruction,
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

    try {
      expect(result.workflow.status).toBe('passed');
      expect(prompts).toHaveLength(1);
      expect(prompts[0]).toContain(nodeInstruction);
      expect(prompts[0]).toContain('Writer system instructions.');

      const nodes = await repositories.listNodes(result.runId);
      const persisted = nodes.find((node) => node.id.endsWith('summary-node'));
      expect(persisted).toBeDefined();
      expect(persisted!.prompt).toBe(nodeInstruction);
      expect(persisted!.role).toBe('writer');

      // 跨进程 resume 的重建路径（无快照时从仓库行还原）必须保留 prompt，
      // 否则新引擎实例重跑会拿到与首跑不同的提示词。
      const rebuiltPlan = await planFromRepository(result.runId, repositories);
      const rebuiltNode = rebuiltPlan.phases
        .flatMap((phase) => phase.nodes)
        .find((node) => node.id.endsWith('summary-node'));
      expect(rebuiltNode?.prompt).toBe(nodeInstruction);
    } finally {
      db.close();
    }
  });
});
