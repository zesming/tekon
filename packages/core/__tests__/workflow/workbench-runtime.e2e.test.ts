import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

  it('isolates quick-dev worktree nodes from primary repo dirty edits and fails closed on non-git repos', async () => {
    const repoPath = makeTempRepo();
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: repoPath });
    writeFileSync(join(repoPath, 'app.ts'), 'export const v = 1;\n', 'utf8');
    execFileSync('git', ['add', 'app.ts'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'init'], { cwd: repoPath });

    // User has uncommitted changes in the primary working tree!
    writeFileSync(join(repoPath, 'app.ts'), 'export const v = 999; // user dirty edit\n', 'utf8');
    writeFileSync(join(repoPath, 'local-untracked.txt'), 'keep me untouched\n', 'utf8');

    const db = openTekonDatabase(join(repoPath, '.tekon', 'tekon.db'));
    migrateDatabase(db);
    const writeQueue = createWriteQueue();

    const seenWorktreePaths: Record<string, string> = {};
    const adapter: AgentAdapter = {
      async runAgent(input) {
        seenWorktreePaths[input.roleConfig.role] = input.worktreeLease.worktreePath;
        if (input.roleConfig.role === 'coder') {
          // Mutate code inside the leased worktree
          writeFileSync(join(input.worktreeLease.worktreePath, 'feature.ts'), 'export const feat = true;\n', 'utf8');
        }
        return {
          provider: 'claude-code',
          exitCode: 0,
          durationMs: 10,
          outputFiles: [],
          assistantText: `done ${input.roleConfig.role}`,
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
        adapters: { 'claude-code': adapter, codex: adapter },
      }),
    });

    try {
      const created = await runtime.createTask({
        mode: 'static',
        templateId: 'quick-dev',
        prompt: '在独立 worktree 中实现 feature.ts',
      });
      await runtime.waitForIdle(created.runId);
      const atConfirm = runtime.getTaskDetail(created.runId);
      expect(atConfirm.status).toBe('paused');
      expect(atConfirm.pauseReason).toBe('confirm_checkpoint');
      await runtime.approveCheckpoint(created.runId);
      await runtime.waitForIdle(created.runId);
      const done = runtime.getTaskDetail(created.runId);
      expect(done.status).toBe('passed');

      // coder (workspace: worktree) MUST run in an isolated `.tekon/worktrees/` path, NOT repoPath!
      expect(seenWorktreePaths.coder).toContain(join('.tekon', 'worktrees'));
      expect(seenWorktreePaths.coder).not.toBe(repoPath);
      // Primary repo working tree must remain untouched!
      expect(readFileSync(join(repoPath, 'app.ts'), 'utf8')).toContain('user dirty edit');
      expect(existsSync(join(repoPath, 'local-untracked.txt'))).toBe(true);
      expect(existsSync(join(repoPath, 'feature.ts'))).toBe(false);
      // Lease directory was released after promotion, and feature.ts is on the delivery branch!
      expect(existsSync(seenWorktreePaths.coder!)).toBe(false);
      const deliveryFile = execFileSync(
        'git',
        ['show', `tekon-delivery/${created.runId}:feature.ts`],
        { cwd: repoPath, encoding: 'utf8' },
      );
      expect(deliveryFile).toContain('export const feat = true;');
      // Node temp branches (`tekon/<runId>/...`) should be cleaned up while delivery branch stays
      const leftoverNodeBranches = execFileSync(
        'git',
        ['branch', '--list', `tekon/${created.runId}/*`],
        { cwd: repoPath, encoding: 'utf8' },
      ).trim();
      expect(leftoverNodeBranches).toBe('');
    } finally {
      await runtime.shutdown();
      db.close();
    }

    // Non-git directory MUST fail closed on workspace: worktree instead of editing repoPath in-place
    const nonGitRepo = makeTempRepo();
    const db2 = openTekonDatabase(join(nonGitRepo, '.tekon', 'tekon.db'));
    migrateDatabase(db2);
    let coderRanInPlace = false;
    const nonGitRuntime = createWorkbenchRuntime({
      db: db2,
      writeQueue: createWriteQueue(),
      repoPath: nonGitRepo,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
      discovery: makeMockDiscovery(),
      resolver: createProviderAdapterResolver({
        repoPath: nonGitRepo,
        defaultDriver: 'claude-code',
        adapters: {
          'claude-code': {
            async runAgent(input) {
              if (input.roleConfig.role === 'coder') coderRanInPlace = true;
              return { provider: 'claude-code', exitCode: 0, durationMs: 5, outputFiles: [], assistantText: 'ok' };
            },
          },
        },
      }),
    });
    try {
      const res = await nonGitRuntime.createTask({
        mode: 'static',
        templateId: 'quick-dev',
        prompt: 'non-git worktree guard',
      });
      await nonGitRuntime.waitForIdle(res.runId);
      const detail = nonGitRuntime.getTaskDetail(res.runId);
      expect(detail.status).toBe('failed');
      expect(coderRanInPlace).toBe(false);
      expect(detail.nodes.find((n) => n.role === 'coder')?.errorMessage).toContain('Git');
    } finally {
      await nonGitRuntime.shutdown();
      db2.close();
    }
  });

  it('delegates legacy task cancel/pause to legacyController, guards readonly legacy tasks, and blocks blueprint confirmation after cancel', async () => {
    const repoPath = makeTempRepo();
    const db = openTekonDatabase(join(repoPath, '.tekon', 'tekon.db'));
    migrateDatabase(db);
    const writeQueue = createWriteQueue();

    const now = new Date().toISOString();
    // Seed a legacy CLI/Web task (demands.source = 'cli', sessions.profile = 'delivery')
    db.prepare(`insert into demands (id, title, body, source, created_at) values ('dem_legacy', '旧 CLI 任务', 'legacy body', 'cli', ?)`).run(now);
    db.prepare(`insert into projects (id, name, repo_path, created_at) values ('proj_legacy', 'repo', ?, ?)`).run(repoPath, now);
    db.prepare(`insert into workflow_instances (id, project_id, demand_id, status, kind, mode, plan_snapshot, created_at, updated_at) values ('run_legacy', 'proj_legacy', 'dem_legacy', 'running', 'workflow', 'static', ?, ?, ?)`).run(
      JSON.stringify({ version: 2, template: { id: 'bugfix', name: 'Bugfix' } }),
      now,
      now,
    );

    const delegatedCalls: string[] = [];
    const stubAdapter: AgentAdapter = {
      async runAgent(input) {
        if (input.runContext.nodeId.startsWith('plan')) {
          return {
            provider: 'claude-code',
            exitCode: 0,
            durationMs: 5,
            outputFiles: [],
            assistantText: JSON.stringify({
              summary: '计划',
              nodes: [{ name: '步骤一', roleId: 'explorer', docKey: 's1', expectedDoc: 's1' }],
            }),
          };
        }
        return {
          provider: 'claude-code',
          exitCode: 1,
          durationMs: 5,
          outputFiles: [],
          diagnostic: { code: 'timeout', message: '追问上游超时' },
        };
      },
    };

    const runtimeWithLegacy = createWorkbenchRuntime({
      db,
      writeQueue,
      repoPath,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
      discovery: makeMockDiscovery(),
      resolver: createProviderAdapterResolver({
        repoPath,
        defaultDriver: 'claude-code',
        adapters: { 'claude-code': stubAdapter },
      }),
      legacyController: {
        async pauseRun(runId) {
          delegatedCalls.push(`pause:${runId}`);
          db.prepare(`update workflow_instances set status = 'paused', updated_at = ? where id = ?`).run(new Date().toISOString(), runId);
        },
        async cancelRun(runId) {
          delegatedCalls.push(`cancel:${runId}`);
          db.prepare(`update workflow_instances set status = 'cancelled', updated_at = ? where id = ?`).run(new Date().toISOString(), runId);
        },
      },
    });

    try {
      // Legacy task detail exposes executor: 'legacy'
      expect(runtimeWithLegacy.getTaskDetail('run_legacy').executor).toBe('legacy');

      // Pause & cancel delegate to legacyController instead of mutating DB directly
      await runtimeWithLegacy.pauseTask('run_legacy');
      await runtimeWithLegacy.cancelTask('run_legacy');
      expect(delegatedCalls).toEqual(['pause:run_legacy', 'cancel:run_legacy']);

      // Workbench-only mutations on legacy task are rejected
      await expect(runtimeWithLegacy.resumeTask('run_legacy')).rejects.toThrow(/LEGACY_TASK_READONLY/u);
      await expect(runtimeWithLegacy.appendConstraint('run_legacy', 'x')).rejects.toThrow(/LEGACY_TASK_READONLY/u);

      // P1-4: Cancelled dynamic task must NOT allow confirmBlueprint or updateBlueprint!
      const dyn = await runtimeWithLegacy.createTask({
        mode: 'dynamic',
        prompt: '动态蓝图取消后防重启测试',
      });
      await runtimeWithLegacy.waitForIdle(dyn.runId);
      expect(runtimeWithLegacy.getTaskDetail(dyn.runId).blueprintStatus).toBe('review');

      await runtimeWithLegacy.cancelTask(dyn.runId);
      expect(runtimeWithLegacy.getTaskDetail(dyn.runId).status).toBe('cancelled');
      await expect(runtimeWithLegacy.confirmBlueprint(dyn.runId)).rejects.toThrow(/BLUEPRINT_NOT_READY|TASK_TERMINAL/u);
      await expect(
        runtimeWithLegacy.updateBlueprint(dyn.runId, {
          nodes: [{ name: 'x', roleId: 'explorer' }],
        }),
      ).rejects.toThrow(/BLUEPRINT_NOT_EDITABLE|TASK_TERMINAL/u);
      await expect(
        runtimeWithLegacy.replanBlueprint(dyn.runId, 'replan after cancel'),
      ).rejects.toThrow(/BLUEPRINT_NOT_EDITABLE|TASK_TERMINAL/u);
      expect(runtimeWithLegacy.getTaskDetail(dyn.runId).status).toBe('cancelled');

      // MF-3: retryNode with unregistered custom driver rejects synchronously without mutating DB
      const { saveLinearWorkflow } = await import('../../src/workflow/template-store.js');
      saveLinearWorkflow({ repoPath, builtInWorkflowsDir: BUILT_IN_WORKFLOWS }, {
        id: 'retry-guard-wf',
        name: '重试守卫测试',
        nodes: [{ id: 'n1', name: '步骤一', role: 'explorer' }],
      });
      const failedTask = await runtimeWithLegacy.createTask({
        mode: 'static',
        templateId: 'retry-guard-wf',
        prompt: 'trigger failure for retry guard',
      });
      await runtimeWithLegacy.waitForIdle(failedTask.runId);
      const failedDetail = runtimeWithLegacy.getTaskDetail(failedTask.runId);
      expect(failedDetail.status).toBe('failed');
      await expect(
        runtimeWithLegacy.retryNode(failedTask.runId, failedDetail.nodes[0]!.id, {
          driver: 'antigravity',
          model: 'gemini-4-neon',
          effort: 'high',
        }),
      ).rejects.toThrow(/PREFLIGHT_BLOCKED/u);
      expect(runtimeWithLegacy.getTaskDetail(failedTask.runId).status).toBe('failed');
      expect(runtimeWithLegacy.getTaskDetail(failedTask.runId).nodes[0]?.status).toBe('failed');

      // P2-3: Unregistered custom agent ('antigravity') is marked 'unsupported' (executable: false)
      const snap = await runtimeWithLegacy.getAgentsSnapshot();
      const customAg = snap.agents.find((a) => a.id === 'antigravity');
      expect(customAg?.status).toBe('unsupported');
      expect(customAg?.executable).toBe(false);
      const claudeAg = snap.agents.find((a) => a.id === 'claude-code');
      expect(claudeAg?.status).toBe('ready');
      expect(claudeAg?.executable).toBe(true);
    } finally {
      await runtimeWithLegacy.shutdown();
    }

    // Without legacyController: legacy task cancel/pause must refuse (read-only) and NOT flip DB status
    db.prepare(`update workflow_instances set status = 'running' where id = 'run_legacy'`).run();
    const runtimeWithoutLegacy = createWorkbenchRuntime({
      db,
      writeQueue,
      repoPath,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
      discovery: makeMockDiscovery(),
      resolver: createProviderAdapterResolver({
        repoPath,
        defaultDriver: 'claude-code',
        adapters: { 'claude-code': stubAdapter },
      }),
    });
    try {
      await expect(runtimeWithoutLegacy.cancelTask('run_legacy')).rejects.toThrow(/LEGACY_TASK_READONLY/u);
      await expect(runtimeWithoutLegacy.pauseTask('run_legacy')).rejects.toThrow(/LEGACY_TASK_READONLY/u);
      expect(runtimeWithoutLegacy.getTaskDetail('run_legacy').status).toBe('running');
    } finally {
      await runtimeWithoutLegacy.shutdown();
      db.close();
    }
  });

  it('rejects failed, timed-out, cancelled, or empty follow-up executions without recording a fake reply', async () => {
    const repoPath = makeTempRepo();
    const db = openTekonDatabase(join(repoPath, '.tekon', 'tekon.db'));
    migrateDatabase(db);
    const writeQueue = createWriteQueue();

    let followUpMode: 'fail' | 'timeout' | 'cancel' | 'empty' = 'fail';
    const adapter: AgentAdapter = {
      async runAgent(input) {
        if (input.runContext.nodeId.startsWith('followup-')) {
          if (followUpMode === 'fail') {
            return {
              provider: 'claude-code',
              exitCode: 1,
              durationMs: 10,
              outputFiles: [],
              diagnostic: { code: 'unclassified', message: 'API 限流 429' },
            };
          }
          if (followUpMode === 'timeout') {
            return {
              provider: 'claude-code',
              exitCode: 0,
              timedOut: true,
              durationMs: 10,
              outputFiles: [],
              diagnostic: { code: 'timeout', message: '300s 超时' },
            };
          }
          if (followUpMode === 'cancel') {
            return {
              provider: 'claude-code',
              exitCode: null,
              cancelled: true,
              durationMs: 10,
              outputFiles: [],
            };
          }
          return {
            provider: 'claude-code',
            exitCode: 0,
            durationMs: 10,
            outputFiles: [],
            assistantText: '   ',
          };
        }
        return {
          provider: 'claude-code',
          exitCode: 0,
          durationMs: 5,
          outputFiles: [],
          assistantText: '节点完成',
        };
      },
    };

    const { saveLinearWorkflow } = await import('../../src/workflow/template-store.js');
    saveLinearWorkflow({ repoPath, builtInWorkflowsDir: BUILT_IN_WORKFLOWS }, {
      id: 'followup-test-wf',
      name: '追问测试',
      nodes: [{ id: 'n1', name: '步骤一', role: 'explorer', docKey: 'out', expectedDoc: '产出' }],
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
        adapters: { 'claude-code': adapter },
      }),
    });

    try {
      const created = await runtime.createTask({
        mode: 'static',
        templateId: 'followup-test-wf',
        prompt: '完成任务后测试追问失败路径',
      });
      await runtime.waitForIdle(created.runId);
      expect(runtime.getTaskDetail(created.runId).status).toBe('passed');

      for (const [mode, pattern] of [
        ['fail', /API 限流 429/u],
        ['timeout', /超时/u],
        ['cancel', /取消/u],
        ['empty', /未返回有效/u],
      ] as const) {
        followUpMode = mode;
        await expect(
          runtime.followUp(created.runId, { prompt: `测试 ${mode}` }),
        ).rejects.toThrow(pattern);
      }

      // None of the failed follow-ups should have been recorded!
      expect(runtime.getTaskDetail(created.runId).followUps).toHaveLength(0);
    } finally {
      await runtime.shutdown();
      db.close();
    }
  });
});
