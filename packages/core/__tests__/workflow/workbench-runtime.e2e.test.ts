import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openTekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createWriteQueue } from '../../src/db/write-queue.js';
import { saveRoleConfig } from '../../src/role/role-store.js';
import type { AgentAdapter } from '../../src/runtime/agent-adapter.js';
import type { AgentDiscoveryRegistry } from '../../src/runtime/agent-discovery.js';
import { createProviderAdapterResolver } from '../../src/runtime/provider-resolver.js';
import { createWorkbenchRuntime } from '../../src/workflow/workbench-runtime.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const BUILT_IN_ROLES = join(REPO_ROOT, 'roles');
const BUILT_IN_WORKFLOWS = join(REPO_ROOT, 'workflows');

const tempDirs: string[] = [];
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-wb-e2e-'));
  tempDirs.push(dir);
  return dir;
}

function makeMockDiscovery(
  overrides: Partial<Record<'claude-code' | 'codex' | 'antigravity', 'ready' | 'unauthenticated'>> = {},
): AgentDiscoveryRegistry {
  const snapshot = {
    probedAt: new Date().toISOString(),
    agents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        iconKey: 'claude-code',
        status: overrides['claude-code'] ?? 'ready',
        models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
        efforts: ['default'],
        source: 'built-in' as const,
        loginHint: '运行 claude auth login',
      },
      {
        id: 'codex',
        name: 'Codex',
        iconKey: 'codex',
        status: overrides.codex ?? 'ready',
        models: ['gpt-5.4', 'gpt-5.3-codex'],
        efforts: ['low', 'medium', 'high', 'xhigh'],
        source: 'built-in' as const,
        loginHint: '运行 codex login',
      },
      {
        id: 'antigravity',
        name: 'Antigravity',
        iconKey: 'antigravity',
        status: overrides.antigravity ?? 'ready',
        models: ['gemini-4-neon'],
        efforts: ['low', 'medium', 'high'],
        source: 'user-config' as const,
      },
    ],
  };
  return {
    async getSnapshot() {
      return snapshot;
    },
    async refresh() {
      return { ...snapshot, probedAt: new Date().toISOString() };
    },
    async getAgent(id) {
      return snapshot.agents.find((a) => a.id === id);
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('workbench-runtime end-to-end multi-provider workflow', () => {
  it('executes 4-node cross-provider Deep Research with confirm/rework, same-role session reuse, snapshot isolation, and follow-up', async () => {
    const repoPath = makeTempRepo();
    const db = openTekonDatabase(join(repoPath, '.tekon', 'tekon.db'));
    migrateDatabase(db);
    const writeQueue = createWriteQueue();

    // Bind explorer & reviewer -> codex, designer -> claude-code (cross-provider mixing!)
    const roleCtx = {
      repoPath,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
    };
    saveRoleConfig(roleCtx, {
      id: 'explorer',
      driver: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
      systemPrompt: 'FROZEN_EXPLORER_PROMPT_V1',
    });
    saveRoleConfig(roleCtx, {
      id: 'designer',
      driver: 'claude-code',
      model: 'claude-sonnet-4-6',
      effort: 'default',
      systemPrompt: 'FROZEN_DESIGNER_PROMPT_V1',
    });
    saveRoleConfig(roleCtx, {
      id: 'reviewer',
      driver: 'codex',
      model: 'gpt-5.3-codex',
      effort: 'xhigh',
      isolated: true,
      systemPrompt: 'FROZEN_REVIEWER_PROMPT_V1',
    });

    const calls: Array<{
      driver: string;
      role: string;
      model?: string;
      effort?: string;
      resumeThreadId?: string;
      prompt: string;
    }> = [];

    const makeStubAdapter = (driver: string): AgentAdapter => ({
      async runAgent(input) {
        // Guard: real CommandGateway rejects empty allow lists (caught by real claude-code bootstrap)
        expect(input.commandPolicy.allow.length).toBeGreaterThan(0);
        expect(input.commandPolicy.allow.some((r) => r.tool === 'claude')).toBe(true);
        calls.push({
          driver,
          role: input.roleConfig.role,
          model: input.providerOverrides?.model,
          effort: input.providerOverrides?.effort,
          resumeThreadId: input.resumeThreadId,
          prompt: input.prompt,
        });
        input.onOutputLine?.({
          stream: 'stdout',
          line: `[${driver}] step for ${input.roleConfig.role}`,
          timestamp: new Date().toISOString(),
        });
        const docType = input.requiredArtifactTypes?.[0];
        const artifacts = [];
        if (docType && input.artifactStore) {
          const content =
            input.roleConfig.role === 'designer' && input.resumeThreadId
              ? '# 知识图谱方案详情\n已吸收评审意见，新增跨仓增量 SCIP 管道'
              : `# ${input.roleConfig.role} 产出\n来自 ${driver} 的正文内容`;
          artifacts.push(
            await input.artifactStore.writeArtifact({
              runId: input.runContext.runId,
              nodeId: input.runContext.nodeId,
              type: docType,
              docKey: docType,
              content,
            }),
          );
        }
        return {
          provider: driver === 'codex' ? 'codex' : 'claude-code',
          exitCode: 0,
          durationMs: 25,
          outputFiles: [],
          artifacts,
          assistantText: `已完成 ${input.roleConfig.role} (${driver})`,
          handoffBrief: `${input.roleConfig.role} 交接摘要 (${driver})`,
          providerThreadId: `thread_${driver}_${input.roleConfig.role}`,
          tokenUsage: {
            inputTokens: 1000,
            cachedInputTokens: input.resumeThreadId ? 740 : 0,
            outputTokens: 300,
          },
        };
      },
    });

    const runtime = createWorkbenchRuntime({
      db,
      writeQueue,
      repoPath,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
      discovery: makeMockDiscovery(),
      resolver: createProviderAdapterResolver({
        repoPath,
        defaultDriver: 'claude-code',
        adapters: {
          codex: makeStubAdapter('codex'),
          'claude-code': makeStubAdapter('claude-code'),
        },
      }),
    });

    try {
      const created = await runtime.createTask({
        mode: 'static',
        templateId: 'deep-research',
        prompt: '研究大型代码工程知识图谱方案',
        attachments: [{ name: 'infra.md', content: '已有内部图存储' }],
      });
      expect(created.sessionId).toBeTruthy();
      await runtime.waitForIdle(created.runId);

      // Should pause at Node 3 confirm checkpoint!
      const atConfirm = runtime.getTaskDetail(created.runId);
      expect(atConfirm.status).toBe('paused');
      expect(atConfirm.pauseReason).toBe('confirm_checkpoint');
      expect(atConfirm.nodes[0]?.driver).toBe('codex');
      expect(atConfirm.nodes[1]?.driver).toBe('claude-code');
      expect(atConfirm.nodes[2]?.driver).toBe('codex');
      expect(atConfirm.nodes[3]?.status).toBe('pending');

      // Mutate designer role on disk while paused -> frozen snapshot isolation must preserve FROZEN_DESIGNER_PROMPT_V1!
      saveRoleConfig(roleCtx, {
        id: 'designer',
        driver: 'codex',
        model: 'gpt-5.4',
        effort: 'low',
        systemPrompt: 'MUTATED_AFTER_START_SHOULD_NOT_APPLY',
      });

      // Rework back to Node 2 with feedback
      await runtime.reworkFromNode(created.runId, atConfirm.nodes[1]!.id, '请补充增量 SCIP 索引延迟目标');
      await runtime.waitForIdle(created.runId);

      const afterRework = runtime.getTaskDetail(created.runId);
      expect(afterRework.status).toBe('paused');
      expect(afterRework.pauseReason).toBe('confirm_checkpoint');
      expect(afterRework.nodes[1]?.reworkCount).toBe(1);

      // Verify designer rework used FROZEN_DESIGNER_PROMPT_V1 and claude-code (NOT mutated disk role!)
      const reworkDesignerCall = calls.filter((c) => c.role === 'designer').at(-1)!;
      expect(reworkDesignerCall.driver).toBe('claude-code');
      expect(reworkDesignerCall.prompt).toContain('FROZEN_DESIGNER_PROMPT_V1');
      expect(reworkDesignerCall.prompt).not.toContain('MUTATED_AFTER_START_SHOULD_NOT_APPLY');

      // Queue mid-run constraint before approving Node 3
      await runtime.appendConstraint(created.runId, '最终方案请给分阶段落地排期');

      // Approve checkpoint -> Node 4 runs reusing Node 2 designer session!
      await runtime.approveCheckpoint(created.runId);
      await runtime.waitForIdle(created.runId);

      const completed = runtime.getTaskDetail(created.runId);
      expect(completed.status).toBe('passed');
      expect(completed.nodes[3]?.status).toBe('passed');
      expect(completed.nodes[3]?.cacheReusePercent).toBe(74);
      const node4Call = calls.at(-1)!;
      expect(node4Call.resumeThreadId).toBe('thread_claude-code_designer');
      expect(node4Call.prompt).toContain('最终方案请给分阶段落地排期');

      // Proposal document evolved across Node 2 -> Node 4 (v1, v2, v3)
      const proposalDoc = completed.documents.find((d) => d.docKey === 'proposal');
      expect(proposalDoc?.versions.length).toBeGreaterThanOrEqual(2);

      // Post-completion follow-up
      const afterFollowUp = await runtime.followUp(created.runId, {
        prompt: '请补充第一阶段 2 周里程碑',
      });
      expect(afterFollowUp.followUps).toHaveLength(1);
    } finally {
      await runtime.shutdown();
      db.close();
    }
  });

  it('supports dynamic blueprint planning with schema repair, editing, confirmation, save-as-template, and preflight blocking', async () => {
    const repoPath = makeTempRepo();
    const db = openTekonDatabase(join(repoPath, '.tekon', 'tekon.db'));
    migrateDatabase(db);
    const writeQueue = createWriteQueue();

    let planAttempt = 0;
    const stub: AgentAdapter = {
      async runAgent(input) {
        if (input.runContext.nodeId.startsWith('plan')) {
          planAttempt += 1;
          // First attempt returns invalid JSON -> verifies 1 auto-repair retry!
          if (planAttempt === 1) {
            return {
              provider: 'claude-code',
              exitCode: 0,
              durationMs: 5,
              outputFiles: [],
              assistantText: 'not valid json',
            };
          }
          return {
            provider: 'claude-code',
            exitCode: 0,
            durationMs: 10,
            outputFiles: [],
            assistantText: JSON.stringify({
              summary: '向量库迁移评估三步流',
              nodes: [
                { name: '选型调研', roleId: 'explorer', docKey: 'benchmark', expectedDoc: '选型对比表', reason: '收集吞吐与内存基线' },
                { name: '迁移方案', roleId: 'designer', docKey: 'migration', expectedDoc: '迁移压测方案', reason: '设计双写与演练', confirmAfter: false },
              ],
            }),
          };
        }
        return {
          provider: 'claude-code',
          exitCode: 0,
          durationMs: 10,
          outputFiles: [],
          assistantText: '动态节点执行完成',
        };
      },
    };

    const runtime = createWorkbenchRuntime({
      db,
      writeQueue,
      repoPath,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
      discovery: makeMockDiscovery(),
      resolver: createProviderAdapterResolver({
        repoPath,
        defaultDriver: 'claude-code',
        adapters: { 'claude-code': stub, codex: stub },
      }),
    });

    try {
      const created = await runtime.createTask({
        mode: 'dynamic',
        prompt: '对比 Milvus 与 Qdrant 迁移方案',
      });
      await runtime.waitForIdle(created.runId);
      const review = runtime.getTaskDetail(created.runId);
      expect(planAttempt).toBe(2);
      expect(review.blueprintStatus).toBe('review');
      expect(review.blueprint?.nodes).toHaveLength(2);

      // Edit blueprint & save as static template
      await runtime.updateBlueprint(created.runId, {
        nodes: [
          ...review.blueprint!.nodes,
          { name: '风险评审', roleId: 'reviewer', docKey: 'risk', expectedDoc: '风险清单', reason: '独立兜底评审' },
        ],
      });
      const savedTpl = await runtime.saveTaskAsTemplate(created.runId, {
        id: 'vector-migration',
        name: '向量库迁移',
      });
      expect(savedTpl.id).toBe('vector-migration');

      // Confirm blueprint -> locks and runs all 3 nodes to completion
      await runtime.confirmBlueprint(created.runId);
      await runtime.waitForIdle(created.runId);
      const done = runtime.getTaskDetail(created.runId);
      expect(done.status).toBe('passed');
      expect(done.nodes).toHaveLength(3);
    } finally {
      await runtime.shutdown();
      db.close();
    }

    // Verify preflight blocker when agent is unauthenticated
    const db2 = openTekonDatabase(join(repoPath, '.tekon', 'tekon2.db'));
    migrateDatabase(db2);
    try {
      const blockedRuntime = createWorkbenchRuntime({
        db: db2,
        writeQueue: createWriteQueue(),
        repoPath,
        builtInRolesDir: BUILT_IN_ROLES,
        builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
        discovery: makeMockDiscovery({ 'claude-code': 'unauthenticated', codex: 'unauthenticated', antigravity: 'unauthenticated' }),
        resolver: createProviderAdapterResolver({ repoPath, defaultDriver: 'claude-code', adapters: { 'claude-code': stub } }),
      });
      await expect(
        blockedRuntime.createTask({ mode: 'static', templateId: 'deep-research', prompt: 'blocked test' }),
      ).rejects.toThrow(/PREFLIGHT_BLOCKED/u);
    } finally {
      db2.close();
    }
  });

  it('supports cooperative mid-flight pause on last node, last-node constraint guard, single-node model-override retry, and irreversible cancel', async () => {
    const repoPath = makeTempRepo();
    const db = openTekonDatabase(join(repoPath, '.tekon', 'tekon.db'));
    migrateDatabase(db);
    const writeQueue = createWriteQueue();

    let failOnce = true;
    let blockOnSecondRun = false;
    let releaseSignal: (() => void) | null = null;
    let enteredRunning: (() => void) | null = null;
    const enteredPromise = new Promise<void>((r) => { enteredRunning = r; });

    const adapter: AgentAdapter = {
      async runAgent(input) {
        if (input.runContext.nodeId.endsWith('_n1') && failOnce) {
          failOnce = false;
          return {
            provider: 'claude-code',
            exitCode: 1,
            durationMs: 10,
            outputFiles: [],
            diagnostic: { code: 'timeout', message: '供应商超时（120s）' },
          };
        }
        if (blockOnSecondRun && input.runContext.nodeId.endsWith('_n1')) {
          enteredRunning?.();
          await new Promise<void>((resolve) => {
            releaseSignal = resolve;
            input.signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          if (input.signal?.aborted) {
            return {
              provider: 'claude-code',
              exitCode: null,
              durationMs: 15,
              outputFiles: [],
              cancelled: true,
            };
          }
        }
        return {
          provider: 'claude-code',
          exitCode: 0,
          durationMs: 10,
          outputFiles: [],
          assistantText: `ok from ${input.providerOverrides?.model ?? 'default'}`,
        };
      },
    };

    // Single-node workflow to test last-node pause & constraint guard
    const roleCtx = {
      repoPath,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
    };
    const { saveLinearWorkflow } = await import('../../src/workflow/template-store.js');
    saveLinearWorkflow({ repoPath, builtInWorkflowsDir: BUILT_IN_WORKFLOWS }, {
      id: 'single-step',
      name: '单步测试',
      nodes: [{ id: 'n1', name: '唯一节点', role: 'explorer', docKey: 'out', expectedDoc: '产出' }],
    });

    const runtime = createWorkbenchRuntime({
      db,
      writeQueue,
      repoPath,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
      discovery: makeMockDiscovery(),
      resolver: createProviderAdapterResolver({
        repoPath,
        defaultDriver: 'claude-code',
        adapters: { 'claude-code': adapter, codex: adapter },
      }),
    });

    try {
      const created = await runtime.createTask({
        mode: 'static',
        templateId: 'single-step',
        prompt: '测试失败重试与暂停',
      });
      await runtime.waitForIdle(created.runId);
      const failed = runtime.getTaskDetail(created.runId);
      expect(failed.status).toBe('failed');

      // Retry with model override while blocking mid-flight to test last-node guard + pause!
      blockOnSecondRun = true;
      await runtime.retryNode(created.runId, failed.nodes[0]!.id, {
        driver: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
      });
      await enteredPromise;

      // Last node running -> appendConstraint must reject with LAST_NODE_RUNNING
      await expect(
        runtime.appendConstraint(created.runId, '中途补充'),
      ).rejects.toThrow(/LAST_NODE_RUNNING/u);

      // Pause mid-flight -> transitions node cleanly to paused!
      const paused = await runtime.pauseTask(created.runId);
      expect(paused.status).toBe('paused');
      expect(paused.pauseReason).toBe('user_pause');
      expect(paused.nodes[0]?.status).toBe('paused');
      expect(paused.nodes[0]?.model).toBe('gpt-5.4');

      // Now paused -> constraint is accepted!
      await runtime.appendConstraint(created.runId, '暂停期间补充的约束');

      // Cancel -> terminal irreversible cancelled
      const cancelled = await runtime.cancelTask(created.runId);
      expect(cancelled.status).toBe('cancelled');
      await expect(runtime.resumeTask(created.runId)).rejects.toThrow(/TASK_TERMINAL/u);
      await expect(runtime.retryNode(created.runId, failed.nodes[0]!.id)).rejects.toThrow(/TASK_TERMINAL/u);
      await expect(runtime.reworkFromNode(created.runId, failed.nodes[0]!.id, 'retry')).rejects.toThrow(/TASK_TERMINAL/u);

      // Attachment secret failure must be fail-closed BEFORE creating any orphan task rows
      const beforeCount = runtime.listTasks().length;
      await expect(
        runtime.createTask({
          mode: 'static',
          templateId: 'quick-dev',
          prompt: 'fail-closed attachment test',
          attachments: [{ name: 'leak.env', content: 'TOKEN=ghp_1234567890abcdef1234567890abcdef1234' }],
        }),
      ).rejects.toThrow(/ATTACHMENT_SECRET_DETECTED/u);
      expect(runtime.listTasks().length).toBe(beforeCount);

      void roleCtx;
      void releaseSignal;
    } finally {
      await runtime.shutdown();
      db.close();
    }
  });
});
