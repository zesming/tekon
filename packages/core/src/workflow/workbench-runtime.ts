import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { z } from 'zod';

import {
  createArtifactStore,
  resolveSafeTekonPath,
} from '../artifact/store.js';
import {
  createContextManager,
  validateTaskAttachments,
  type ContextManager,
  type FollowUpTurnRecord,
  type SolidifiedDocumentItem,
} from '../context/context-manager.js';
import {
  renderNodeContextPrompt,
  resolveSameRoleReuseMode,
  type ContextGeneralEntry,
} from '../context/context-package.js';
import type { TekonDatabase } from '../db/connection.js';
import { createRepositories, type TekonRepositories } from '../db/repositories.js';
import type { WriteQueue } from '../db/write-queue.js';
import { loadRole } from '../role/loader.js';
import { assertSafeProviderOverrideValue } from '../role/override-safety.js';
import { listRolesDetailed } from '../role/role-store.js';
import type { AgentRunInput, OutputStreamLine } from '../runtime/agent-adapter.js';
import type { AgentDiscoveryRegistry } from '../runtime/agent-discovery.js';
import type { ProviderAdapterResolver } from '../runtime/provider-resolver.js';
import type { SessionEventBus } from '../session/event-bus.js';
import {
  createSessionEventStore,
  type SessionEventStore,
} from '../session/session-store.js';
import {
  createSubprocessRegistry,
  type SubprocessRegistry,
} from '../session/subprocess-registry.js';
import type {
  BlueprintStatus,
  NodeContextMode,
  NodeStatus,
  NodeWorkspace,
  Role,
  WorkflowPauseReason,
  WorkflowStatus,
} from '../types/domain.js';
import {
  identifierSchema,
  nodeContextModeSchema,
  roleSchema,
} from '../types/domain.js';
import {
  getLinearWorkflow,
  saveLinearWorkflow,
  type LinearWorkflowNodeInput,
} from './template-store.js';
import { defaultCommandPolicy } from './workflow-runtime.js';

export const JOB_ABORT_REASON_PAUSE = 'TEKON_PAUSE_REQUESTED';

export interface FrozenRoleSnapshot {
  roleId: Role;
  name: string;
  driver: string;
  model: string;
  effort: string;
  systemPrompt: string;
  isolated: boolean;
}

export const dynamicBlueprintNodeSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1).max(120),
  roleId: roleSchema,
  docKey: identifierSchema.optional(),
  expectedDoc: z.string().max(120).optional(),
  reason: z.string().max(300).optional(),
  confirmAfter: z.boolean().optional(),
  overrideModel: z.string().max(128).optional(),
  overrideEffort: z.string().max(32).optional(),
  contextMode: nodeContextModeSchema.optional(),
});

export const dynamicBlueprintSchema = z.object({
  summary: z.string().max(500).optional(),
  nodes: z.array(dynamicBlueprintNodeSchema).min(1).max(12),
});

export type DynamicBlueprintNode = z.infer<typeof dynamicBlueprintNodeSchema> & {
  id: string;
};
export type DynamicBlueprint = {
  summary?: string;
  nodes: DynamicBlueprintNode[];
  error?: string;
};

export interface TaskListItem {
  runId: string;
  sessionId: string | null;
  title: string;
  mode: 'static' | 'dynamic';
  templateName: string;
  status: WorkflowStatus;
  pauseReason: WorkflowPauseReason | null;
  blueprintStatus: BlueprintStatus | null;
  uiCategory: 'running' | 'attention' | 'done';
  progressLabel: string;
  completedNodes: number;
  totalNodes: number;
  updatedAt: string;
  createdAt: string;
}

export interface TaskNodeView {
  id: string;
  name: string;
  role: Role;
  status: NodeStatus;
  order: number;
  driver: string;
  model: string;
  effort: string;
  contextMode: NodeContextMode;
  docKey: string | null;
  expectedDoc: string | null;
  confirmAfter: boolean;
  attemptGeneration: number;
  reworkCount: number;
  durationMs: number | null;
  tokenInput: number | null;
  tokenCached: number | null;
  tokenOutput: number | null;
  cacheReusePercent: number | null;
  handoffBrief: string | null;
  traceSummary: string | null;
  traceLines: string[];
  errorMessage: string | null;
  reuseAnchorOrder: number | null;
  reuseMode: 'new' | 'isolated' | 'reuse' | 'reset';
}

export interface TaskDetailView {
  runId: string;
  sessionId: string | null;
  title: string;
  prompt: string;
  mode: 'static' | 'dynamic';
  templateId: string | null;
  templateName: string;
  status: WorkflowStatus;
  pauseReason: WorkflowPauseReason | null;
  blueprintStatus: BlueprintStatus | null;
  blueprint: DynamicBlueprint | null;
  currentNodeId: string | null;
  lastRoleId: string | null;
  nodes: TaskNodeView[];
  documents: SolidifiedDocumentItem[];
  queuedConstraints: ContextGeneralEntry[];
  followUps: FollowUpTurnRecord[];
  createdAt: string;
  updatedAt: string;
}

export interface PreflightBlocker {
  nodeId: string;
  nodeName: string;
  roleId: string;
  agentId: string;
  status: 'unauthenticated' | 'not_installed' | 'missing_role';
  message: string;
  loginHint?: string;
  installHint?: string;
}

export interface CreateWorkbenchRuntimeOptions {
  db: TekonDatabase;
  writeQueue: WriteQueue;
  repoPath: string;
  builtInRolesDir: string;
  builtInWorkflowsDir: string;
  userHome?: string;
  discovery: AgentDiscoveryRegistry;
  resolver: ProviderAdapterResolver;
  eventBus?: SessionEventBus;
  subprocessRegistry?: SubprocessRegistry;
  repositories?: TekonRepositories;
  contextManager?: ContextManager;
  sessionStore?: SessionEventStore;
}

export interface WorkbenchRuntime {
  contextManager: ContextManager;
  discovery: AgentDiscoveryRegistry;
  getWorkspaceInfo(): { name: string; path: string };
  listTasks(options?: {
    filter?: 'all' | 'running' | 'attention' | 'done';
    q?: string;
  }): TaskListItem[];
  getTaskDetail(runId: string): TaskDetailView;
  createTask(input: {
    mode: 'static' | 'dynamic';
    templateId?: string;
    prompt: string;
    attachments?: Array<{ name: string; content: string }>;
  }): Promise<{
    runId: string;
    sessionId: string;
    task: TaskDetailView;
  }>;
  pauseTask(runId: string): Promise<TaskDetailView>;
  resumeTask(runId: string): Promise<TaskDetailView>;
  cancelTask(runId: string): Promise<TaskDetailView>;
  appendConstraint(runId: string, text: string): Promise<TaskDetailView>;
  approveCheckpoint(runId: string): Promise<TaskDetailView>;
  reworkFromNode(
    runId: string,
    targetNodeId: string,
    note: string,
  ): Promise<TaskDetailView>;
  retryNode(
    runId: string,
    nodeId: string,
    override?: { driver?: string; model?: string; effort?: string },
  ): Promise<TaskDetailView>;
  followUp(
    runId: string,
    input: { roleId?: string; prompt: string },
  ): Promise<TaskDetailView>;
  updateBlueprint(
    runId: string,
    blueprint: { nodes: Array<z.input<typeof dynamicBlueprintNodeSchema>> },
  ): Promise<TaskDetailView>;
  replanBlueprint(runId: string, instruction?: string): Promise<TaskDetailView>;
  confirmBlueprint(runId: string): Promise<TaskDetailView>;
  saveTaskAsTemplate(
    runId: string,
    input: { id?: string; name: string; description?: string },
  ): Promise<{ id: string; name: string }>;
  waitForIdle(runId?: string): Promise<void>;
  shutdown(): Promise<void>;
}

interface ActiveRunControl {
  controller: AbortController;
  promise: Promise<void>;
  reason?: 'pause' | 'cancel';
}

function deriveTitle(prompt: string): string {
  const oneLine = prompt.replace(/\s+/gu, ' ').trim();
  return oneLine.length > 48 ? `${oneLine.slice(0, 47)}…` : oneLine || '未命名任务';
}

function slugifyId(text: string, prefix: string): string {
  const ascii = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 32);
  const candidate = ascii && /^[a-z]/u.test(ascii) ? ascii : `${prefix}-${Date.now().toString(36).slice(-5)}`;
  return candidate;
}

function classifyUiCategory(
  status: WorkflowStatus,
  pauseReason: WorkflowPauseReason | null,
  blueprintStatus: BlueprintStatus | null,
): 'running' | 'attention' | 'done' {
  if (status === 'passed' || status === 'cancelled') return 'done';
  if (
    status === 'failed' ||
    status === 'blocked' ||
    status === 'paused' ||
    pauseReason !== null ||
    blueprintStatus === 'review' ||
    blueprintStatus === 'failed'
  ) {
    return 'attention';
  }
  return 'running';
}

export function createWorkbenchRuntime(
  options: CreateWorkbenchRuntimeOptions,
): WorkbenchRuntime {
  const {
    db,
    writeQueue,
    repoPath,
    builtInRolesDir,
    builtInWorkflowsDir,
    userHome,
    discovery,
    resolver,
    eventBus,
  } = options;

  const repositories =
    options.repositories ?? createRepositories(db, writeQueue);
  const contextManager =
    options.contextManager ??
    createContextManager({ db, writeQueue, repoPath });
  const sessionStore =
    options.sessionStore ?? createSessionEventStore(db, writeQueue);
  const subprocessRegistry =
    options.subprocessRegistry ?? createSubprocessRegistry();
  const artifactStore = createArtifactStore({ repoPath, repositories });

  const activeRuns = new Map<string, ActiveRunControl>();
  const liveNodeTraces = new Map<string, string[]>();
  const liveNodeErrors = new Map<string, string>();

  function getWorkspaceInfo() {
    return { name: basename(repoPath) || repoPath, path: repoPath };
  }

  async function ensureWorkspaceRow(): Promise<string> {
    const existing = db
      .prepare('select id from workspaces where root = ? limit 1')
      .get(repoPath) as { id: string } | undefined;
    if (existing) return existing.id;
    const id = `ws_${randomUUID()}`;
    await writeQueue.enqueue(() => {
      db.prepare(
        `insert into workspaces (id, root, created_at) values (?, ?, ?)`,
      ).run(id, repoPath, new Date().toISOString());
    });
    return id;
  }

  async function emitEvent(
    sessionId: string | null,
    type: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    if (!sessionId) return;
    try {
      const ev = await sessionStore.appendEvent({
        sessionId,
        type,
        payload,
        visibility: 'ui-only',
        modelVisible: false,
      });
      eventBus?.publish(ev);
    } catch {
      // non-fatal event projection error
    }
  }

  async function resolveRoleExecutionSpec(
    roleId: string,
    overrides?: { model?: string; effort?: string },
  ): Promise<
    | { ok: true; snapshot: FrozenRoleSnapshot }
    | { ok: false; blocker: Omit<PreflightBlocker, 'nodeId' | 'nodeName'> }
  > {
    const discoverySnap = await discovery.getSnapshot();
    const readyAgents = discoverySnap.agents.filter((a) => a.status === 'ready');

    let loaded;
    try {
      loaded = loadRole({
        role: roleId,
        repoPath,
        builtInRolesDir,
        userHome,
      });
    } catch {
      return {
        ok: false,
        blocker: {
          roleId,
          agentId: 'unknown',
          status: 'missing_role',
          message: `角色「${roleId}」不存在或已损坏`,
        },
      };
    }

    const declaredDriver = loaded.agent.driver?.trim();
    const driver =
      declaredDriver || readyAgents[0]?.id || resolver.defaultDriver;
    const agent = discoverySnap.agents.find((a) => a.id === driver);

    if (driver !== 'mock' && (!agent || agent.status !== 'ready')) {
      const status = agent?.status === 'unauthenticated' ? 'unauthenticated' : 'not_installed';
      return {
        ok: false,
        blocker: {
          roleId,
          agentId: driver,
          status,
          message:
            status === 'unauthenticated'
              ? `Agent「${driver}」未登录，无法启动`
              : `Agent「${driver}」未安装或未就绪，无法启动`,
          loginHint: agent?.loginHint,
          installHint: agent?.installHint,
        },
      };
    }

    if (!resolver.has(driver)) {
      return {
        ok: false,
        blocker: {
          roleId,
          agentId: driver,
          status: 'not_installed',
          message: `执行驱动「${driver}」尚未注册到当前运行时，请在设置中切换为可用 Agent`,
          installHint: agent?.installHint,
        },
      };
    }

    const model =
      overrides?.model?.trim() ||
      loaded.agent.model?.trim() ||
      agent?.models[0] ||
      'default';
    const effort =
      overrides?.effort?.trim() ||
      loaded.agent.effort?.trim() ||
      agent?.efforts[0] ||
      'default';

    if (model && model !== 'default') {
      assertSafeProviderOverrideValue('model', model);
    }
    if (effort && effort !== 'default') {
      assertSafeProviderOverrideValue('effort', effort);
    }

    return {
      ok: true,
      snapshot: {
        roleId,
        name: loaded.agent.name ?? roleId,
        driver,
        model,
        effort,
        systemPrompt: loaded.systemPrompt,
        isolated: Boolean(loaded.agent.isolated),
      },
    };
  }

  function getSessionIdForRun(runId: string): string | null {
    const row = db
      .prepare('select id from sessions where run_id = ? order by created_at desc limit 1')
      .get(runId) as { id: string } | undefined;
    return row?.id ?? null;
  }

  function listTasks(
    opts: { filter?: 'all' | 'running' | 'attention' | 'done'; q?: string } = {},
  ): TaskListItem[] {
    const rows = db
      .prepare(
        `select wi.id as run_id,
                (select s.id from sessions s where s.run_id = wi.id order by s.created_at desc limit 1) as session_id,
                d.title as title,
                wi.mode as mode,
                wi.plan_snapshot as plan_snapshot,
                wi.status as status,
                wi.pause_reason as pause_reason,
                wi.blueprint_status as blueprint_status,
                wi.created_at as created_at,
                wi.updated_at as updated_at,
                (select count(*) from nodes n where n.run_id = wi.id) as total_nodes,
                (select count(*) from nodes n where n.run_id = wi.id and n.status = 'passed') as completed_nodes
         from workflow_instances wi
         join demands d on d.id = wi.demand_id
         order by wi.updated_at desc`,
      )
      .all() as Array<{
      run_id: string;
      session_id: string | null;
      title: string;
      mode: 'static' | 'dynamic' | null;
      plan_snapshot: string | null;
      status: WorkflowStatus;
      pause_reason: WorkflowPauseReason | null;
      blueprint_status: BlueprintStatus | null;
      created_at: string;
      updated_at: string;
      total_nodes: number;
      completed_nodes: number;
    }>;

    const query = (opts.q ?? '').trim().toLowerCase();
    const filter = opts.filter ?? 'all';

    const items: TaskListItem[] = [];
    for (const r of rows) {
      let templateName = r.mode === 'dynamic' ? '动态编排' : '工作流';
      if (r.plan_snapshot) {
        try {
          const snap = JSON.parse(r.plan_snapshot) as {
            templateName?: string;
            template?: { name?: string };
          };
          templateName = snap.templateName ?? snap.template?.name ?? templateName;
        } catch {
          // ignore
        }
      }
      const mode = r.mode ?? 'static';
      const uiCategory = classifyUiCategory(
        r.status,
        r.pause_reason,
        r.blueprint_status,
      );
      if (filter !== 'all' && uiCategory !== filter) continue;
      if (
        query &&
        !r.title.toLowerCase().includes(query) &&
        !templateName.toLowerCase().includes(query)
      ) {
        continue;
      }

      let progressLabel = `${r.completed_nodes}/${r.total_nodes}`;
      if (mode === 'dynamic' && r.blueprint_status === 'planning') {
        progressLabel = '编排中';
      } else if (mode === 'dynamic' && r.blueprint_status === 'review') {
        progressLabel = '蓝图待确认';
      } else if (mode === 'dynamic' && r.blueprint_status === 'failed') {
        progressLabel = '编排失败';
      } else if (r.status === 'cancelled') {
        progressLabel = '已取消';
      } else if (r.status === 'failed') {
        progressLabel = `${r.completed_nodes}/${r.total_nodes} 失败`;
      } else if (r.pause_reason === 'confirm_checkpoint') {
        progressLabel = `${r.completed_nodes}/${r.total_nodes} 待确认`;
      } else if (r.pause_reason === 'user_pause') {
        progressLabel = '已暂停';
      }

      items.push({
        runId: r.run_id,
        sessionId: r.session_id,
        title: r.title,
        mode,
        templateName,
        status: r.status,
        pauseReason: r.pause_reason,
        blueprintStatus: r.blueprint_status,
        uiCategory,
        progressLabel,
        completedNodes: r.completed_nodes,
        totalNodes: r.total_nodes,
        updatedAt: r.updated_at,
        createdAt: r.created_at,
      });
    }
    return items;
  }

  function getTaskDetail(runId: string): TaskDetailView {
    const row = db
      .prepare(
        `select wi.id as run_id,
                d.title as title,
                d.body as prompt,
                wi.mode as mode,
                wi.plan_snapshot as plan_snapshot,
                wi.status as status,
                wi.pause_reason as pause_reason,
                wi.blueprint_json as blueprint_json,
                wi.blueprint_status as blueprint_status,
                wi.current_node_id as current_node_id,
                wi.last_role_id as last_role_id,
                wi.created_at as created_at,
                wi.updated_at as updated_at
         from workflow_instances wi
         join demands d on d.id = wi.demand_id
         where wi.id = ?`,
      )
      .get(runId) as
      | {
          run_id: string;
          title: string;
          prompt: string;
          mode: 'static' | 'dynamic' | null;
          plan_snapshot: string | null;
          status: WorkflowStatus;
          pause_reason: WorkflowPauseReason | null;
          blueprint_json: string | null;
          blueprint_status: BlueprintStatus | null;
          current_node_id: string | null;
          last_role_id: string | null;
          created_at: string;
          updated_at: string;
        }
      | undefined;

    if (!row) {
      throw new Error(`TASK_NOT_FOUND: 任务 '${runId}' 不存在。`);
    }

    let templateId: string | null = null;
    let templateName = row.mode === 'dynamic' ? '动态编排' : '工作流';
    if (row.plan_snapshot) {
      try {
        const snap = JSON.parse(row.plan_snapshot) as {
          templateId?: string;
          templateName?: string;
          template?: { id?: string; name?: string };
        };
        templateId = snap.templateId ?? snap.template?.id ?? null;
        templateName = snap.templateName ?? snap.template?.name ?? templateName;
      } catch {
        // ignore
      }
    }

    let blueprint: DynamicBlueprint | null = null;
    if (row.blueprint_json) {
      try {
        blueprint = JSON.parse(row.blueprint_json) as DynamicBlueprint;
      } catch {
        blueprint = null;
      }
    }

    const nodeRows = db
      .prepare(
        `select id, name, role, status, node_order, resolved_driver, resolved_model,
                resolved_effort, frozen_role_json, context_mode, doc_key, expected_doc,
                confirm_after, attempt_generation, rework_count, duration_ms,
                token_input, token_cached, token_output
         from nodes
         where run_id = ?
         order by node_order asc, id asc`,
      )
      .all(runId) as Array<{
      id: string;
      name: string | null;
      role: Role;
      status: NodeStatus;
      node_order: number;
      resolved_driver: string | null;
      resolved_model: string | null;
      resolved_effort: string | null;
      frozen_role_json: string | null;
      context_mode: NodeContextMode | null;
      doc_key: string | null;
      expected_doc: string | null;
      confirm_after: number | null;
      attempt_generation: number | null;
      rework_count: number | null;
      duration_ms: number | null;
      token_input: number | null;
      token_cached: number | null;
      token_output: number | null;
    }>;

    const generalEntries = contextManager.listGeneralEntries(runId);
    const archives = contextManager.listArchives(runId);

    const nodes: TaskNodeView[] = nodeRows.map((n, idx) => {
      const handoff = generalEntries
        .filter((e) => e.kind === 'handoff' && e.nodeId === n.id)
        .at(-1);
      const traceArchive = archives.find(
        (a) => a.kind === 'private_trace' && a.nodeId === n.id,
      );
      const liveLines = liveNodeTraces.get(`${runId}:${n.id}`) ?? [];
      let traceLines = liveLines;
      if (traceLines.length === 0 && traceArchive) {
        try {
          const { content } = contextManager.getArchiveContent(
            runId,
            traceArchive.id,
          );
          traceLines = content
            .split(/\r?\n/u)
            .map((l) => l.trim())
            .filter(Boolean)
            .slice(-30);
        } catch {
          traceLines = [];
        }
      }

      let roleIsolated = n.role === 'reviewer';
      if (n.frozen_role_json) {
        try {
          const f = JSON.parse(n.frozen_role_json) as { isolated?: boolean };
          if (typeof f.isolated === 'boolean') roleIsolated = f.isolated;
        } catch {
          // ignore
        }
      }

      let reuseAnchorOrder: number | null = null;
      let reuseMode: TaskNodeView['reuseMode'] =
        n.context_mode === 'isolated' || roleIsolated ? 'isolated' : 'new';
      if (reuseMode !== 'isolated') {
        for (let i = idx - 1; i >= 0; i -= 1) {
          if (nodeRows[i]!.role === n.role) {
            reuseAnchorOrder = i + 1;
            const rs = contextManager.getRoleSession(runId, n.role);
            const sameDriver =
              !rs?.driver || !n.resolved_driver || rs.driver === n.resolved_driver;
            reuseMode = resolveSameRoleReuseMode(
              n.context_mode ?? 'auto',
              sameDriver ? (rs?.reuseMode ?? 'reuse') : 'reset',
            );
            break;
          }
        }
      }

      const cacheReusePercent =
        n.token_input && n.token_input > 0 && n.token_cached != null
          ? Math.round((n.token_cached / n.token_input) * 100)
          : null;

      return {
        id: n.id,
        name: n.name ?? n.id,
        role: n.role,
        status: n.status,
        order: n.node_order,
        driver: n.resolved_driver ?? resolver.defaultDriver,
        model: n.resolved_model ?? 'default',
        effort: n.resolved_effort ?? 'default',
        contextMode: n.context_mode ?? 'auto',
        docKey: n.doc_key ?? null,
        expectedDoc: n.expected_doc ?? null,
        confirmAfter: Boolean(n.confirm_after),
        attemptGeneration: n.attempt_generation ?? 1,
        reworkCount: n.rework_count ?? 0,
        durationMs: n.duration_ms ?? null,
        tokenInput: n.token_input ?? null,
        tokenCached: n.token_cached ?? null,
        tokenOutput: n.token_output ?? null,
        cacheReusePercent,
        handoffBrief: handoff?.content ?? null,
        traceSummary:
          traceArchive?.summary ||
          (traceLines.length > 0 ? `${traceLines.length} 条过程日志` : null),
        traceLines,
        errorMessage: liveNodeErrors.get(`${runId}:${n.id}`) ?? null,
        reuseAnchorOrder,
        reuseMode,
      };
    });

    return {
      runId: row.run_id,
      sessionId: getSessionIdForRun(runId),
      title: row.title,
      prompt: row.prompt,
      mode: row.mode ?? 'static',
      templateId,
      templateName,
      status: row.status,
      pauseReason: row.pause_reason,
      blueprintStatus: row.blueprint_status,
      blueprint,
      currentNodeId: row.current_node_id,
      lastRoleId: row.last_role_id,
      nodes,
      documents: contextManager.listRunDocuments(runId),
      queuedConstraints: generalEntries.filter((e) => e.status === 'queued_next'),
      followUps: contextManager.listFollowUpTurns(runId),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function assertNotActivelyRunning(runId: string): void {
    if (activeRuns.has(runId)) {
      throw new Error('TASK_ALREADY_RUNNING: 任务正在执行中，请勿重复触发。');
    }
  }

  function launchBackground(
    runId: string,
    fn: (signal: AbortSignal) => Promise<void>,
  ): void {
    assertNotActivelyRunning(runId);
    const controller = new AbortController();
    const control: ActiveRunControl = {
      controller,
      promise: Promise.resolve(),
    };
    const promise = fn(controller.signal)
      .catch(async (err) => {
        const message = err instanceof Error ? err.message : String(err);
        const now = new Date().toISOString();
        try {
          await writeQueue.enqueue(() => {
            db.prepare(
              `update nodes set status = 'failed', updated_at = ? where run_id = ? and status = 'running'`,
            ).run(now, runId);
            db.prepare(
              `update role_runs set status = 'failed', completed_at = ? where run_id = ? and status = 'running'`,
            ).run(now, runId);
            db.prepare(
              `update workflow_instances
               set status = 'failed', pause_reason = null, updated_at = ?
               where id = ? and status in ('running', 'pending')`,
            ).run(now, runId);
          });
          const curNode = db
            .prepare(`select current_node_id from workflow_instances where id = ?`)
            .get(runId) as { current_node_id: string | null } | undefined;
          if (curNode?.current_node_id) {
            liveNodeErrors.set(`${runId}:${curNode.current_node_id}`, message);
          }
          await emitEvent(getSessionIdForRun(runId), 'workflow/status', {
            runId,
            status: 'failed',
            error: message,
          });
        } catch {
          // ignore secondary cleanup errors
        }
      })
      .finally(() => {
        if (activeRuns.get(runId) === control) {
          activeRuns.delete(runId);
        }
      });
    control.promise = promise;
    activeRuns.set(runId, control);
  }

  async function executeSequentialNodes(
    runId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const sessionId = getSessionIdForRun(runId);
    const nowIso = () => new Date().toISOString();

    await writeQueue.enqueue(() => {
      db.prepare(
        `update workflow_instances
         set status = 'running', pause_reason = null, paused_at = null, updated_at = ?
         where id = ?`,
      ).run(nowIso(), runId);
    });

    const nodeRows = db
      .prepare(
        `select id, name, role, status, workspace, prompt, resolved_driver, resolved_model,
                resolved_effort, frozen_role_json, context_mode, doc_key, expected_doc,
                confirm_after, attempt_generation, node_order
         from nodes
         where run_id = ?
         order by node_order asc, id asc`,
      )
      .all(runId) as Array<{
      id: string;
      name: string | null;
      role: Role;
      status: NodeStatus;
      workspace: NodeWorkspace;
      prompt: string | null;
      resolved_driver: string | null;
      resolved_model: string | null;
      resolved_effort: string | null;
      frozen_role_json: string | null;
      context_mode: NodeContextMode | null;
      doc_key: string | null;
      expected_doc: string | null;
      confirm_after: number | null;
      attempt_generation: number | null;
      node_order: number;
    }>;

    for (const node of nodeRows) {
      if (node.status === 'passed' || node.status === 'skipped') {
        continue;
      }

      // Check abort before starting node
      if (signal.aborted) {
        const isPause =
          signal.reason === JOB_ABORT_REASON_PAUSE ||
          activeRuns.get(runId)?.reason === 'pause';
        await writeQueue.enqueue(() => {
          db.prepare(
            `update workflow_instances
             set status = ?, pause_reason = ?, paused_at = ?, updated_at = ?
             where id = ?`,
          ).run(
            isPause ? 'paused' : 'cancelled',
            isPause ? 'user_pause' : null,
            isPause ? nowIso() : null,
            nowIso(),
            runId,
          );
        });
        return;
      }

      // Activate queued user constraints at node start boundary
      await contextManager.activateQueuedConstraints(runId);

      // Parse frozen role snapshot (NEVER reads disk `.tekon/roles/` during execution!)
      let frozenRole: FrozenRoleSnapshot;
      if (node.frozen_role_json) {
        frozenRole = JSON.parse(node.frozen_role_json) as FrozenRoleSnapshot;
      } else {
        frozenRole = {
          roleId: node.role,
          name: node.role,
          driver: node.resolved_driver ?? resolver.defaultDriver,
          model: node.resolved_model ?? 'default',
          effort: node.resolved_effort ?? 'default',
          systemPrompt: `你是 ${node.role}。请按要求完成当前节点任务。`,
          isolated: node.role === 'reviewer',
        };
      }

      const driver = node.resolved_driver ?? frozenRole.driver;
      const model = node.resolved_model ?? frozenRole.model;
      const effort = node.resolved_effort ?? frozenRole.effort;
      const attemptGen = node.attempt_generation ?? 1;

      liveNodeErrors.delete(`${runId}:${node.id}`);
      const traceBuf: string[] = [];
      liveNodeTraces.set(`${runId}:${node.id}`, traceBuf);

      const roleRunId = `rr_${randomUUID()}`;
      const startedAt = nowIso();
      const startMs = Date.now();

      await writeQueue.enqueue(() => {
        db.prepare(
          `update nodes set status = 'running', updated_at = ? where id = ?`,
        ).run(startedAt, node.id);
        db.prepare(
          `update workflow_instances
           set status = 'running', current_node_id = ?, last_role_id = ?, updated_at = ?
           where id = ?`,
        ).run(node.id, node.role, startedAt, runId);
        db.prepare(
          `insert into role_runs (id, run_id, node_id, role, status, started_at, attempt_generation)
           values (?, ?, ?, ?, 'running', ?, ?)`,
        ).run(roleRunId, runId, node.id, node.role, startedAt, attemptGen);
      });

      await emitEvent(sessionId, 'node/status', {
        runId,
        nodeId: node.id,
        status: 'running',
        driver,
        model,
        effort,
      });

      // Single Source of Truth context package (identical to context.inspectNode!)
      const pkg = contextManager.inspectNodeContext({ runId, nodeId: node.id });
      const prompt = renderNodeContextPrompt({
        pkg,
        systemPrompt: frozenRole.systemPrompt,
        overridePrompt: node.prompt ?? undefined,
        docKey: node.doc_key ?? undefined,
        expectedDoc: node.expected_doc ?? undefined,
      });

      // Exact 4-segment `.tekon/runs/<runId>/<nodeId>` layout matching Codex adapter contract
      const outputDir = resolveSafeTekonPath(
        repoPath,
        `.tekon/runs/${runId}/${node.id}`,
      );
      mkdirSync(outputDir, { recursive: true });
      if (attemptGen > 1) {
        // Clear stale handoff/doc files from prior attempt so rework never reads previous-gen output
        rmSync(join(outputDir, 'handoff.json'), { force: true });
        if (node.doc_key) {
          rmSync(join(outputDir, `${node.doc_key}.md`), { force: true });
        }
      }

      let lastProgressEmit = 0;
      const onOutputLine = (ev: OutputStreamLine) => {
        traceBuf.push(ev.line);
        if (traceBuf.length > 200) traceBuf.shift();
        const now = Date.now();
        if (now - lastProgressEmit >= 250) {
          lastProgressEmit = now;
          void emitEvent(sessionId, 'node/progress', {
            runId,
            nodeId: node.id,
            line: ev.line,
            count: traceBuf.length,
          });
        }
      };

      const { adapter } = resolver.resolve(driver);
      const runInput: AgentRunInput = {
        roleConfig: { role: node.role, name: frozenRole.name },
        prompt,
        worktreeLease: {
          id: `lease_${runId}_${node.id}`,
          runId,
          nodeId: node.id,
          role: node.role,
          repoPath,
          worktreePath: repoPath,
          branchName: 'in-place',
          createdAt: startedAt,
        },
        outputDir,
        commandPolicy: defaultCommandPolicy(repoPath),
        runContext: {
          runId,
          nodeId: node.id,
          projectId: basename(repoPath) || 'default',
          repoPath,
          dataDir: join(repoPath, '.tekon'),
        },
        artifactStore,
        requiredArtifactTypes: node.doc_key ? [node.doc_key] : [],
        signal,
        providerOverrides: {
          ...(model && model !== 'default' ? { model } : {}),
          ...(effort && effort !== 'default' ? { effort } : {}),
        },
        ...(pkg.session.mode === 'reuse' && pkg.session.providerThreadId
          ? { resumeThreadId: pkg.session.providerThreadId }
          : {}),
        onOutputLine,
        allowGeneralFallback: true,
      };

      let result;
      try {
        result = await adapter.runAgent(runInput);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        result = {
          provider: 'custom' as const,
          exitCode: 1,
          durationMs: Date.now() - startMs,
          outputFiles: [],
          diagnostic: { code: 'unclassified' as const, message },
        };
      }

      const durationMs = result.durationMs ?? Date.now() - startMs;
      const finishedAt = nowIso();

      // Distinguish Pause abort vs Cancel abort!
      if (signal.aborted || result.cancelled) {
        const isPause =
          signal.reason === JOB_ABORT_REASON_PAUSE ||
          activeRuns.get(runId)?.reason === 'pause';
        await writeQueue.enqueue(() => {
          db.prepare(
            `update nodes set status = ?, duration_ms = ?, updated_at = ? where id = ?`,
          ).run(isPause ? 'paused' : 'interrupted', durationMs, finishedAt, node.id);
          db.prepare(
            `update role_runs set status = ?, interrupted_at = ? where id = ?`,
          ).run(isPause ? 'paused' : 'interrupted', finishedAt, roleRunId);
          db.prepare(
            `update workflow_instances
             set status = ?, pause_reason = ?, paused_at = ?, updated_at = ?
             where id = ?`,
          ).run(
            isPause ? 'paused' : 'cancelled',
            isPause ? 'user_pause' : null,
            isPause ? finishedAt : null,
            finishedAt,
            runId,
          );
        });
        await emitEvent(sessionId, 'node/status', {
          runId,
          nodeId: node.id,
          status: isPause ? 'paused' : 'interrupted',
        });
        return;
      }

      if (result.exitCode !== 0 || result.timedOut) {
        const errMsg =
          result.diagnostic?.message ||
          (result.timedOut ? '节点执行超时' : `退出码 ${result.exitCode ?? 1}`);
        liveNodeErrors.set(`${runId}:${node.id}`, errMsg);
        await writeQueue.enqueue(() => {
          db.prepare(
            `update nodes set status = 'failed', duration_ms = ?, updated_at = ? where id = ?`,
          ).run(durationMs, finishedAt, node.id);
          db.prepare(
            `update role_runs set status = 'failed', completed_at = ? where id = ?`,
          ).run(finishedAt, roleRunId);
          db.prepare(
            `update workflow_instances set status = 'failed', updated_at = ? where id = ?`,
          ).run(finishedAt, runId);
        });
        await emitEvent(sessionId, 'node/status', {
          runId,
          nodeId: node.id,
          status: 'failed',
          error: errMsg,
        });
        return;
      }

      // Node succeeded! Persist handoff brief, private trace archive, role session, and token usage
      const handoffBrief =
        result.handoffBrief?.trim() ||
        result.assistantText?.trim().slice(0, 1500) ||
        `已完成「${node.name ?? node.id}」。`;
      await contextManager.appendGeneralEntry({
        runId,
        nodeId: node.id,
        kind: 'handoff',
        content: handoffBrief,
      });

      const prefs = contextManager.getPreferences();
      const traceLines = result.traceLines?.length ? result.traceLines : traceBuf;
      if (prefs.autoArchiveLogs && traceLines.length > 0) {
        await contextManager.recordArchive({
          runId,
          nodeId: node.id,
          kind: 'private_trace',
          title: `${node.name ?? node.id} 私有过程日志 (${traceLines.length})`,
          summary: `${traceLines.length} 条过程日志 · ${Math.max(1, Math.round(durationMs / 1000))}s`,
          content: traceLines.join('\n'),
        });
      }

      // Update role session anchor & token window tracking
      const inputTokens = result.tokenUsage?.inputTokens ?? null;
      const cachedTokens = result.tokenUsage?.cachedInputTokens ?? null;
      const outputTokens = result.tokenUsage?.outputTokens ?? null;

      if (!frozenRole.isolated && node.context_mode !== 'isolated') {
        const prevSession = contextManager.getRoleSession(runId, node.role);
        await contextManager.upsertRoleSession({
          runId,
          roleId: node.role,
          driver,
          providerThreadId: result.sessionResumeFallback
            ? (result.providerThreadId ?? null)
            : (result.providerThreadId ?? prevSession?.providerThreadId ?? null),
          anchorNodeId: prevSession?.anchorNodeId ?? node.id,
          windowTokens:
            (prevSession?.windowTokens ?? 0) +
            (inputTokens ?? Math.round(prompt.length / 4)) +
            (outputTokens ?? Math.round(handoffBrief.length / 4)),
        });
      }

      // Update node title/docKey metadata if artifacts were created
      if (result.artifacts && result.artifacts.length > 0) {
        await writeQueue.enqueue(() => {
          for (const art of result.artifacts!) {
            if (node.expected_doc && !art.title) {
              db.prepare(
                `update artifacts set title = ?, doc_key = coalesce(doc_key, ?) where id = ?`,
              ).run(node.expected_doc, node.doc_key ?? art.type, art.id);
            }
          }
        });
        await emitEvent(sessionId, 'doc/created', {
          runId,
          nodeId: node.id,
          count: result.artifacts.length,
        });
      }

      await writeQueue.enqueue(() => {
        db.prepare(
          `update nodes
           set status = 'passed',
               duration_ms = ?,
               token_input = ?,
               token_cached = ?,
               token_output = ?,
               updated_at = ?
           where id = ?`,
        ).run(
          durationMs,
          inputTokens,
          cachedTokens,
          outputTokens,
          finishedAt,
          node.id,
        );
        db.prepare(
          `update role_runs set status = 'passed', completed_at = ? where id = ?`,
        ).run(finishedAt, roleRunId);
      });

      await emitEvent(sessionId, 'node/status', {
        runId,
        nodeId: node.id,
        status: 'passed',
        durationMs,
      });

      // Human confirmation checkpoint after node
      if (node.confirm_after) {
        await writeQueue.enqueue(() => {
          db.prepare(
            `update workflow_instances
             set status = 'paused', pause_reason = 'confirm_checkpoint',
                 current_node_id = ?, paused_at = ?, updated_at = ?
             where id = ?`,
          ).run(node.id, finishedAt, finishedAt, runId);
        });
        await emitEvent(sessionId, 'checkpoint/waiting', {
          runId,
          nodeId: node.id,
          nodeName: node.name ?? node.id,
        });
        return;
      }
    }

    // All nodes passed!
    const doneAt = nowIso();
    await writeQueue.enqueue(() => {
      db.prepare(
        `update workflow_instances
         set status = 'passed', pause_reason = null, current_node_id = null, updated_at = ?
         where id = ?`,
      ).run(doneAt, runId);
    });
    await emitEvent(sessionId, 'node/status', {
      runId,
      status: 'passed',
    });
  }

  async function runDynamicPlanning(
    runId: string,
    prompt: string,
    extraInstruction: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const sessionId = getSessionIdForRun(runId);
    const prefs = contextManager.getPreferences();
    const orchRoleId = prefs.defaultOrchestrator || 'orchestrator';
    const resolved = await resolveRoleExecutionSpec(orchRoleId);
    const nowIso = () => new Date().toISOString();

    if (!resolved.ok) {
      const bp: DynamicBlueprint = {
        nodes: [],
        error: resolved.blocker.message,
      };
      await writeQueue.enqueue(() => {
        db.prepare(
          `update workflow_instances
           set status = 'failed', blueprint_status = 'failed', blueprint_json = ?, updated_at = ?
           where id = ?`,
        ).run(JSON.stringify(bp), nowIso(), runId);
      });
      await emitEvent(sessionId, 'blueprint/updated', {
        runId,
        blueprintStatus: 'failed',
        error: resolved.blocker.message,
      });
      return;
    }

    const availableRoles = listRolesDetailed({
      repoPath,
      builtInRolesDir,
      builtInWorkflowsDir,
      userHome,
    });
    const roleIds = new Set(availableRoles.map((r) => r.id));
    const roleCatalogText = availableRoles
      .map(
        (r) =>
          `- ${r.id}（${r.name}）：${r.description || r.systemPrompt.slice(0, 80)}`,
      )
      .join('\n');

    const { adapter } = resolver.resolve(resolved.snapshot.driver);
    const basePrompt = [
      resolved.snapshot.systemPrompt,
      `# 可用角色库\n${roleCatalogText}`,
      `# 用户需求\n${prompt}`,
      ...(extraInstruction ? [`# 补充调整要求\n${extraInstruction}`] : []),
      [
        '# 输出格式要求',
        '请仅输出一个合法的 JSON 对象，包含 `summary` 和 `nodes`（2~5 个有序节点），每个节点含：',
        '`{"name":"节点名","roleId":"可用角色id","docKey":"kebab-case","expectedDoc":"预期文档名","reason":"推荐理由","confirmAfter":false}`。',
      ].join('\n'),
    ].join('\n\n---\n\n');

    const handlePlanningAbort = async (): Promise<void> => {
      const isPause =
        signal.reason === JOB_ABORT_REASON_PAUSE ||
        activeRuns.get(runId)?.reason === 'pause';
      const now = nowIso();
      await writeQueue.enqueue(() => {
        db.prepare(
          `update workflow_instances
           set status = ?, pause_reason = ?, paused_at = ?, updated_at = ?
           where id = ?`,
        ).run(
          isPause ? 'paused' : 'cancelled',
          isPause ? 'user_pause' : null,
          isPause ? now : null,
          now,
          runId,
        );
      });
      await emitEvent(sessionId, 'workflow/status', {
        runId,
        status: isPause ? 'paused' : 'cancelled',
      });
    };

    let lastError = '编排者未返回合法蓝图 JSON';
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (signal.aborted) {
        await handlePlanningAbort();
        return;
      }
      const attemptPrompt =
        attempt === 1
          ? basePrompt
          : `${basePrompt}\n\n# 上次输出校验失败（请修正并仅输出合法 JSON）\n${lastError}`;

      const planNodeId = `plan-attempt-${attempt}`;
      const outputDir = resolveSafeTekonPath(
        repoPath,
        `.tekon/runs/${runId}/${planNodeId}`,
      );
      mkdirSync(outputDir, { recursive: true });

      let res;
      try {
        res = await adapter.runAgent({
          roleConfig: { role: orchRoleId, name: resolved.snapshot.name },
          prompt: attemptPrompt,
          worktreeLease: {
            id: `lease_${runId}_${planNodeId}`,
            runId,
            nodeId: planNodeId,
            role: orchRoleId,
            repoPath,
            worktreePath: repoPath,
            branchName: 'in-place',
            createdAt: nowIso(),
          },
          outputDir,
          commandPolicy: defaultCommandPolicy(repoPath),
          runContext: {
            runId,
            nodeId: planNodeId,
            projectId: basename(repoPath) || 'default',
            repoPath,
            dataDir: join(repoPath, '.tekon'),
          },
          signal,
          providerOverrides: {
            ...(resolved.snapshot.model !== 'default'
              ? { model: resolved.snapshot.model }
              : {}),
            ...(resolved.snapshot.effort !== 'default'
              ? { effort: resolved.snapshot.effort }
              : {}),
          },
          allowGeneralFallback: true,
        });
      } catch (err) {
        if (signal.aborted) {
          await handlePlanningAbort();
          return;
        }
        lastError = err instanceof Error ? err.message : String(err);
        continue;
      }

      if (signal.aborted || res.cancelled) {
        await handlePlanningAbort();
        return;
      }

      if (res.exitCode !== 0 || res.timedOut) {
        lastError = res.diagnostic?.message ?? '编排者执行超时或异常退出';
        continue;
      }

      const rawText = (res.assistantText ?? res.handoffBrief ?? '').trim();
      const jsonMatch = rawText.match(/\{[\s\S]*\}/u);
      if (!jsonMatch) {
        lastError = '输出中未找到 JSON 对象';
        continue;
      }
      try {
        const parsed = dynamicBlueprintSchema.parse(JSON.parse(jsonMatch[0]));
        const invalidRole = parsed.nodes.find((n) => !roleIds.has(n.roleId));
        if (invalidRole) {
          lastError = `引用了不存在的角色 '${invalidRole.roleId}'`;
          continue;
        }
        const bp: DynamicBlueprint = {
          summary: parsed.summary,
          nodes: parsed.nodes.map((n, idx) => ({
            ...n,
            id: n.id || `n${idx + 1}`,
            docKey: n.docKey || `step-${idx + 1}`,
          })),
        };
        await writeQueue.enqueue(() => {
          db.prepare(
            `update workflow_instances
             set status = 'paused',
                 pause_reason = 'blueprint_review',
                 blueprint_status = 'review',
                 blueprint_json = ?,
                 paused_at = ?,
                 updated_at = ?
             where id = ?`,
          ).run(JSON.stringify(bp), nowIso(), nowIso(), runId);
        });
        await emitEvent(sessionId, 'blueprint/updated', {
          runId,
          blueprintStatus: 'review',
          nodeCount: bp.nodes.length,
        });
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const failedBp: DynamicBlueprint = { nodes: [], error: lastError };
    await writeQueue.enqueue(() => {
      db.prepare(
        `update workflow_instances
         set status = 'failed', blueprint_status = 'failed', blueprint_json = ?, updated_at = ?
         where id = ?`,
      ).run(JSON.stringify(failedBp), nowIso(), runId);
    });
    await emitEvent(sessionId, 'blueprint/updated', {
      runId,
      blueprintStatus: 'failed',
      error: lastError,
    });
  }

  async function materializeNodesForRun(
    runId: string,
    phaseId: string,
    nodesInput: Array<{
      id: string;
      name: string;
      roleId: Role;
      workspace?: NodeWorkspace;
      contextMode?: NodeContextMode;
      docKey?: string;
      expectedDoc?: string;
      confirmAfter?: boolean;
      overrideModel?: string;
      overrideEffort?: string;
      overridePrompt?: string;
    }>,
  ): Promise<{ blockers: PreflightBlocker[] }> {
    const blockers: PreflightBlocker[] = [];
    const prepared: Array<{
      node: (typeof nodesInput)[number];
      frozen: FrozenRoleSnapshot;
    }> = [];

    for (const n of nodesInput) {
      const res = await resolveRoleExecutionSpec(n.roleId, {
        model: n.overrideModel,
        effort: n.overrideEffort,
      });
      if (!res.ok) {
        blockers.push({
          nodeId: n.id,
          nodeName: n.name,
          ...res.blocker,
        });
      } else {
        prepared.push({ node: n, frozen: res.snapshot });
      }
    }

    if (blockers.length > 0) {
      return { blockers };
    }

    const now = new Date().toISOString();
    await writeQueue.enqueue(() => {
      db.prepare(`delete from nodes where run_id = ?`).run(runId);
      const stmt = db.prepare(
        `insert into nodes (
           id, run_id, phase_id, role, status, prompt, workspace, inputs, outputs,
           gates, dependencies, node_order, name, resolved_driver, resolved_model,
           resolved_effort, frozen_role_json, context_mode, doc_key, expected_doc,
           confirm_after, attempt_generation, rework_count, created_at, updated_at
         ) values (
           ?, ?, ?, ?, 'pending', ?, ?, '[]', '[]',
           '[]', ?, ?, ?, ?, ?,
           ?, ?, ?, ?, ?,
           ?, 1, 0, ?, ?
         )`,
      );
      for (let i = 0; i < prepared.length; i += 1) {
        const { node, frozen } = prepared[i]!;
        const deps = i > 0 ? [prepared[i - 1]!.node.id] : [];
        const ws: NodeWorkspace =
          node.workspace ?? (node.roleId === 'coder' ? 'worktree' : 'none');
        stmt.run(
          node.id,
          runId,
          phaseId,
          node.roleId,
          node.overridePrompt?.trim() || null,
          ws,
          JSON.stringify(deps),
          i,
          node.name,
          frozen.driver,
          frozen.model,
          frozen.effort,
          JSON.stringify(frozen),
          node.contextMode ?? (frozen.isolated ? 'isolated' : 'auto'),
          node.docKey ?? null,
          node.expectedDoc ?? null,
          node.confirmAfter ? 1 : 0,
          now,
          now,
        );
      }
    });

    return { blockers: [] };
  }

  return {
    contextManager,
    discovery,
    getWorkspaceInfo,
    listTasks,
    getTaskDetail,

    async createTask(input) {
      const prompt = input.prompt.trim();
      if (!prompt) {
        throw new Error('TASK_PROMPT_REQUIRED: 请输入任务目标或需求。');
      }
      if (input.attachments?.length) {
        validateTaskAttachments(input.attachments);
      }

      const runId = `run_${randomUUID().slice(0, 12)}`;
      const demandId = `demand_${randomUUID().slice(0, 12)}`;
      const projectId = `proj_${randomUUID().slice(0, 12)}`;
      const phaseId = `phase_${runId}_main`;
      const sessionId = `sess_${randomUUID().slice(0, 12)}`;
      const workspaceId = await ensureWorkspaceRow();
      const title = deriveTitle(prompt);
      const now = new Date().toISOString();

      if (input.mode === 'static') {
        const templateId = input.templateId?.trim() || 'deep-research';
        const wf = getLinearWorkflow(
          { repoPath, builtInWorkflowsDir },
          templateId,
        );

        // Preflight check ALL referenced roles & agents BEFORE creating any DB rows
        const blockers: PreflightBlocker[] = [];
        for (const n of wf.nodes) {
          const check = await resolveRoleExecutionSpec(n.role, {
            model: n.overrideModel,
            effort: n.overrideEffort,
          });
          if (!check.ok) {
            blockers.push({
              nodeId: n.id,
              nodeName: n.name,
              ...check.blocker,
            });
          }
        }
        if (blockers.length > 0) {
          const err = new Error(
            `PREFLIGHT_BLOCKED: ${blockers.map((b) => b.message).join('；')}`,
          ) as Error & { blockers?: PreflightBlocker[] };
          err.blockers = blockers;
          throw err;
        }

        await writeQueue.enqueue(() => {
          db.prepare(
            `insert into demands (id, title, body, source, created_at) values (?, ?, ?, 'workbench', ?)`,
          ).run(demandId, title, prompt, now);
          db.prepare(
            `insert into projects (id, name, repo_path, created_at) values (?, ?, ?, ?)`,
          ).run(projectId, basename(repoPath), repoPath, now);
          db.prepare(
            `insert into workflow_instances (
               id, project_id, demand_id, status, kind, mode, plan_snapshot, created_at, updated_at
             ) values (?, ?, ?, 'pending', 'workflow', 'static', ?, ?, ?)`,
          ).run(
            runId,
            projectId,
            demandId,
            JSON.stringify({
              version: 4,
              templateId: wf.id,
              templateName: wf.name,
            }),
            now,
            now,
          );
          db.prepare(
            `insert into phases (id, run_id, name, status, phase_order, created_at, updated_at)
             values (?, ?, ?, 'pending', 0, ?, ?)`,
          ).run(phaseId, runId, wf.name, now, now);
          db.prepare(
            `insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
             values (?, ?, ?, 'workbench', 'active', ?, ?, ?)`,
          ).run(sessionId, workspaceId, title, runId, now, now);
        });

        await contextManager.appendGeneralEntry({
          runId,
          kind: 'goal',
          content: prompt,
        });
        if (input.attachments?.length) {
          await contextManager.addTaskAttachments(runId, input.attachments);
        }

        const { blockers: matBlockers } = await materializeNodesForRun(
          runId,
          phaseId,
          wf.nodes.map((n, idx) => ({
            id: `${runId}_${n.id || `n${idx + 1}`}`,
            name: n.name,
            roleId: n.role,
            workspace: n.workspace,
            contextMode: n.contextMode,
            docKey: n.docKey,
            expectedDoc: n.expectedDoc,
            confirmAfter: n.confirmAfter,
            overrideModel: n.overrideModel,
            overrideEffort: n.overrideEffort,
            overridePrompt: n.overridePrompt,
          })),
        );
        if (matBlockers.length > 0) {
          throw new Error(
            `PREFLIGHT_BLOCKED: ${matBlockers.map((b) => b.message).join('；')}`,
          );
        }

        launchBackground(runId, (sig) => executeSequentialNodes(runId, sig));
        return { runId, sessionId, task: getTaskDetail(runId) };
      }

      // Dynamic orchestration task
      await writeQueue.enqueue(() => {
        db.prepare(
          `insert into demands (id, title, body, source, created_at) values (?, ?, ?, 'workbench', ?)`,
        ).run(demandId, title, prompt, now);
        db.prepare(
          `insert into projects (id, name, repo_path, created_at) values (?, ?, ?, ?)`,
        ).run(projectId, basename(repoPath), repoPath, now);
        db.prepare(
          `insert into workflow_instances (
             id, project_id, demand_id, status, kind, mode, blueprint_status, plan_snapshot, created_at, updated_at
           ) values (?, ?, ?, 'running', 'workflow', 'dynamic', 'planning', ?, ?, ?)`,
        ).run(
          runId,
          projectId,
          demandId,
          JSON.stringify({ version: 4, templateName: '动态编排' }),
          now,
          now,
        );
        db.prepare(
          `insert into phases (id, run_id, name, status, phase_order, created_at, updated_at)
           values (?, ?, '动态编排', 'pending', 0, ?, ?)`,
        ).run(phaseId, runId, now, now);
        db.prepare(
          `insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at)
           values (?, ?, ?, 'workbench', 'active', ?, ?, ?)`,
        ).run(sessionId, workspaceId, title, runId, now, now);
      });

      await contextManager.appendGeneralEntry({
        runId,
        kind: 'goal',
        content: prompt,
      });
      if (input.attachments?.length) {
        await contextManager.addTaskAttachments(runId, input.attachments);
      }

      launchBackground(runId, (sig) =>
        runDynamicPlanning(runId, prompt, undefined, sig),
      );
      return { runId, sessionId, task: getTaskDetail(runId) };
    },

    async pauseTask(runId) {
      const active = activeRuns.get(runId);
      if (active) {
        active.reason = 'pause';
        active.controller.abort(JOB_ABORT_REASON_PAUSE);
        subprocessRegistry.killAll(runId, 'SIGTERM');
        await active.promise;
      } else {
        const now = new Date().toISOString();
        await writeQueue.enqueue(() => {
          // Only pause running/pending runs; never clobber confirm_checkpoint or blueprint_review
          db.prepare(
            `update workflow_instances
             set status = 'paused', pause_reason = 'user_pause', paused_at = ?, updated_at = ?
             where id = ? and status in ('running', 'pending')`,
          ).run(now, now, runId);
        });
      }
      return getTaskDetail(runId);
    },

    async resumeTask(runId) {
      const task = getTaskDetail(runId);
      if (task.status === 'cancelled' || task.status === 'passed') {
        throw new Error(`TASK_TERMINAL: 任务处于终态 '${task.status}'，无法继续。`);
      }
      if (task.status !== 'paused' || task.pauseReason !== 'user_pause') {
        throw new Error(
          `TASK_NOT_RESUMABLE: 仅人工暂停的任务可通过继续恢复（当前状态：${task.status}/${task.pauseReason ?? 'none'}）。`,
        );
      }
      assertNotActivelyRunning(runId);
      if (task.mode === 'dynamic' && task.blueprintStatus !== 'locked') {
        await writeQueue.enqueue(() => {
          db.prepare(
            `update workflow_instances
             set status = 'running', pause_reason = null, blueprint_status = 'planning', updated_at = ?
             where id = ?`,
          ).run(new Date().toISOString(), runId);
        });
        launchBackground(runId, (sig) =>
          runDynamicPlanning(runId, task.prompt, undefined, sig),
        );
        return getTaskDetail(runId);
      }
      await writeQueue.enqueue(() => {
        db.prepare(
          `update workflow_instances
           set status = 'running', pause_reason = null, updated_at = ?
           where id = ?`,
        ).run(new Date().toISOString(), runId);
      });
      launchBackground(runId, (sig) => executeSequentialNodes(runId, sig));
      return getTaskDetail(runId);
    },

    async cancelTask(runId) {
      const existing = getTaskDetail(runId);
      if (existing.status === 'passed') {
        throw new Error('TASK_TERMINAL: 已完成的任务不可终止。');
      }
      const active = activeRuns.get(runId);
      if (active) {
        active.reason = 'cancel';
        active.controller.abort('cancel');
        subprocessRegistry.killAll(runId, 'SIGTERM');
        await active.promise;
      }
      const now = new Date().toISOString();
      await writeQueue.enqueue(() => {
        db.prepare(
          `update workflow_instances
           set status = 'cancelled', pause_reason = null, updated_at = ?
           where id = ? and status != 'passed'`,
        ).run(now, runId);
      });
      return getTaskDetail(runId);
    },

    async appendConstraint(runId, text) {
      const content = text.trim();
      if (!content) return getTaskDetail(runId);
      const task = getTaskDetail(runId);
      if (task.status === 'cancelled') {
        throw new Error('TASK_CANCELLED: 已取消任务不可补充约束。');
      }
      const lastNode = task.nodes[task.nodes.length - 1];
      if (
        task.status === 'running' &&
        lastNode &&
        lastNode.status === 'running'
      ) {
        throw new Error(
          'LAST_NODE_RUNNING: 当前已是最后一个节点运行中，请先暂停后调整或等待完成后追问。',
        );
      }
      await contextManager.appendGeneralEntry({
        runId,
        kind: 'constraint',
        content,
        status: 'queued_next',
      });
      await emitEvent(task.sessionId, 'context/updated', { runId });
      return getTaskDetail(runId);
    },

    async approveCheckpoint(runId) {
      assertNotActivelyRunning(runId);
      const task = getTaskDetail(runId);
      if (task.pauseReason !== 'confirm_checkpoint') {
        throw new Error('NO_PENDING_CHECKPOINT: 当前任务没有待确认的人工确认点。');
      }
      await writeQueue.enqueue(() => {
        db.prepare(
          `update workflow_instances
           set status = 'running', pause_reason = null, updated_at = ?
           where id = ?`,
        ).run(new Date().toISOString(), runId);
      });
      launchBackground(runId, (sig) => executeSequentialNodes(runId, sig));
      return getTaskDetail(runId);
    },

    async reworkFromNode(runId, targetNodeId, note) {
      assertNotActivelyRunning(runId);
      const feedback = note.trim();
      if (!feedback) {
        throw new Error('REWORK_NOTE_REQUIRED: 请填写打回修改意见。');
      }
      const task = getTaskDetail(runId);
      if (task.status === 'cancelled' || task.status === 'passed') {
        throw new Error(`TASK_TERMINAL: 任务处于终态 '${task.status}'，不可发起返工。`);
      }
      const targetIdx = task.nodes.findIndex((n) => n.id === targetNodeId);
      if (targetIdx < 0) {
        throw new Error(`NODE_NOT_FOUND: 打回目标节点 '${targetNodeId}' 不存在。`);
      }

      // Archive existing docs before rework so old versions stay inspectable
      for (const doc of task.documents) {
        if (doc.source === 'artifact') {
          try {
            const { content } = contextManager.getDocumentContent(runId, doc.id);
            await contextManager.recordArchive({
              runId,
              nodeId: doc.nodeId,
              kind: 'doc_snapshot',
              title: `${doc.title} v${doc.version} 快照`,
              summary: `返工前归档 · ${doc.summary}`,
              content,
            });
          } catch {
            // ignore missing doc file
          }
        }
      }

      await contextManager.appendGeneralEntry({
        runId,
        nodeId: targetNodeId,
        kind: 'rework_feedback',
        content: `打回目标「${task.nodes[targetIdx]!.name}」：${feedback}`,
      });

      const now = new Date().toISOString();
      const nodesToRework = task.nodes.slice(targetIdx);
      await writeQueue.enqueue(() => {
        for (const n of nodesToRework) {
          const nextStatus: NodeStatus =
            n.status === 'pending' ? 'pending' : 'needs-revision';
          db.prepare(
            `update nodes
             set status = ?,
                 attempt_generation = attempt_generation + 1,
                 rework_count = rework_count + ?,
                 updated_at = ?
             where id = ?`,
          ).run(nextStatus, n.id === targetNodeId ? 1 : 0, now, n.id);
        }
        db.prepare(
          `update workflow_instances
           set status = 'running', pause_reason = null, paused_at = null, updated_at = ?
           where id = ?`,
        ).run(now, runId);
      });

      launchBackground(runId, (sig) => executeSequentialNodes(runId, sig));
      return getTaskDetail(runId);
    },

    async retryNode(runId, nodeId, override) {
      assertNotActivelyRunning(runId);
      const task = getTaskDetail(runId);
      if (task.status === 'cancelled' || task.status === 'passed') {
        throw new Error(`TASK_TERMINAL: 任务处于终态 '${task.status}'，不可重试节点。`);
      }
      const target = task.nodes.find((n) => n.id === nodeId);
      if (!target) {
        throw new Error(`NODE_NOT_FOUND: 节点 '${nodeId}' 不存在。`);
      }

      if (override?.driver) {
        assertSafeProviderOverrideValue('model', override.driver);
      }
      if (override?.model && override.model !== 'default') {
        assertSafeProviderOverrideValue('model', override.model);
      }
      if (override?.effort && override.effort !== 'default') {
        assertSafeProviderOverrideValue('effort', override.effort);
      }

      const now = new Date().toISOString();
      await writeQueue.enqueue(() => {
        const row = db
          .prepare(
            `select resolved_driver, resolved_model, resolved_effort, frozen_role_json
             from nodes where id = ?`,
          )
          .get(nodeId) as {
          resolved_driver: string | null;
          resolved_model: string | null;
          resolved_effort: string | null;
          frozen_role_json: string | null;
        };
        const nextDriver = override?.driver || row.resolved_driver || target.driver;
        const nextModel = override?.model || row.resolved_model || target.model;
        const nextEffort = override?.effort || row.resolved_effort || target.effort;
        let frozenJson = row.frozen_role_json;
        if (frozenJson) {
          try {
            const parsed = JSON.parse(frozenJson) as FrozenRoleSnapshot;
            parsed.driver = nextDriver;
            parsed.model = nextModel;
            parsed.effort = nextEffort;
            frozenJson = JSON.stringify(parsed);
          } catch {
            // ignore
          }
        }
        db.prepare(
          `update nodes
           set status = 'running',
               resolved_driver = ?,
               resolved_model = ?,
               resolved_effort = ?,
               frozen_role_json = ?,
               attempt_generation = attempt_generation + 1,
               updated_at = ?
           where id = ?`,
        ).run(nextDriver, nextModel, nextEffort, frozenJson, now, nodeId);
        db.prepare(
          `update workflow_instances set status = 'running', updated_at = ? where id = ?`,
        ).run(now, runId);
      });

      liveNodeErrors.delete(`${runId}:${nodeId}`);
      launchBackground(runId, (sig) => executeSequentialNodes(runId, sig));
      return getTaskDetail(runId);
    },

    async followUp(runId, input) {
      const userPrompt = input.prompt.trim();
      if (!userPrompt) {
        throw new Error('FOLLOWUP_REQUIRED: 请输入追问内容。');
      }
      const task = getTaskDetail(runId);
      if (task.status !== 'passed') {
        throw new Error('TASK_NOT_COMPLETED: 仅已完成的任务支持直接追问。');
      }
      const roleId = input.roleId?.trim() || task.lastRoleId || 'designer';
      const resolved = await resolveRoleExecutionSpec(roleId);
      if (!resolved.ok) {
        throw new Error(`PREFLIGHT_BLOCKED: ${resolved.blocker.message}`);
      }

      const docsSummary = task.documents
        .map((d) => {
          const { content } = contextManager.getDocumentContent(runId, d.id);
          return `## ${d.title} (${d.docKey} v${d.version})\n${content}`;
        })
        .join('\n\n---\n\n');
      const fullPrompt = [
        resolved.snapshot.systemPrompt,
        `# 任务原始目标\n${task.prompt}`,
        docsSummary ? `# 最新固化文档\n${docsSummary}` : '',
        `# 用户追问\n${userPrompt}`,
      ]
        .filter(Boolean)
        .join('\n\n---\n\n');

      const roleSession = contextManager.getRoleSession(runId, roleId);
      const followNodeId = `followup-${Date.now()}`;
      const outputDir = resolveSafeTekonPath(
        repoPath,
        `.tekon/runs/${runId}/${followNodeId}`,
      );
      mkdirSync(outputDir, { recursive: true });

      const { adapter } = resolver.resolve(resolved.snapshot.driver);
      const res = await adapter.runAgent({
        roleConfig: { role: roleId, name: resolved.snapshot.name },
        prompt: fullPrompt,
        worktreeLease: {
          id: `lease_${runId}_${followNodeId}`,
          runId,
          nodeId: followNodeId,
          role: roleId,
          repoPath,
          worktreePath: repoPath,
          branchName: 'in-place',
          createdAt: new Date().toISOString(),
        },
        outputDir,
        commandPolicy: defaultCommandPolicy(repoPath),
        runContext: {
          runId,
          nodeId: followNodeId,
          projectId: basename(repoPath) || 'default',
          repoPath,
          dataDir: join(repoPath, '.tekon'),
        },
        providerOverrides: {
          ...(resolved.snapshot.model !== 'default'
            ? { model: resolved.snapshot.model }
            : {}),
          ...(resolved.snapshot.effort !== 'default'
            ? { effort: resolved.snapshot.effort }
            : {}),
        },
        ...(roleSession?.providerThreadId
          ? { resumeThreadId: roleSession.providerThreadId }
          : {}),
        allowGeneralFallback: true,
      });

      const reply =
        res.assistantText?.trim() ||
        res.handoffBrief?.trim() ||
        '已结合最新固化文档给出回应。';

      await contextManager.recordFollowUpTurn({
        runId,
        roleId,
        driver: resolved.snapshot.driver,
        model: resolved.snapshot.model,
        userText: userPrompt,
        assistantText: reply,
      });
      await emitEvent(task.sessionId, 'followup/completed', { runId, roleId });
      return getTaskDetail(runId);
    },

    async updateBlueprint(runId, input) {
      const task = getTaskDetail(runId);
      if (task.mode !== 'dynamic' || task.blueprintStatus !== 'review') {
        throw new Error('BLUEPRINT_NOT_EDITABLE: 仅处于待确认状态的动态蓝图可编辑。');
      }
      const parsed = dynamicBlueprintSchema.parse({ nodes: input.nodes });
      const bp: DynamicBlueprint = {
        summary: task.blueprint?.summary,
        nodes: parsed.nodes.map((n, idx) => ({
          ...n,
          id: n.id || `n${idx + 1}`,
          docKey: n.docKey || `step-${idx + 1}`,
        })),
      };
      await writeQueue.enqueue(() => {
        db.prepare(
          `update workflow_instances set blueprint_json = ?, updated_at = ? where id = ?`,
        ).run(JSON.stringify(bp), new Date().toISOString(), runId);
      });
      return getTaskDetail(runId);
    },

    async replanBlueprint(runId, instruction) {
      assertNotActivelyRunning(runId);
      const task = getTaskDetail(runId);
      if (task.mode !== 'dynamic') {
        throw new Error('NOT_DYNAMIC_TASK: 该任务不是动态编排任务。');
      }
      if (task.status === 'cancelled' || task.status === 'passed') {
        throw new Error(`TASK_TERMINAL: 任务处于终态 '${task.status}'，不可重新规划。`);
      }
      if (task.blueprintStatus === 'locked') {
        throw new Error('BLUEPRINT_NOT_EDITABLE: 计划已确认并锁定执行，无法重新规划。');
      }
      await writeQueue.enqueue(() => {
        db.prepare(
          `update workflow_instances
           set status = 'running', pause_reason = null, blueprint_status = 'planning', updated_at = ?
           where id = ?`,
        ).run(new Date().toISOString(), runId);
      });
      launchBackground(runId, (sig) =>
        runDynamicPlanning(runId, task.prompt, instruction, sig),
      );
      return getTaskDetail(runId);
    },

    async confirmBlueprint(runId) {
      assertNotActivelyRunning(runId);
      const task = getTaskDetail(runId);
      if (
        task.mode !== 'dynamic' ||
        task.blueprintStatus !== 'review' ||
        !task.blueprint ||
        task.blueprint.nodes.length === 0
      ) {
        throw new Error('BLUEPRINT_NOT_READY: 动态蓝图尚未就绪或已锁定。');
      }
      const phaseId = `phase_${runId}_main`;
      const { blockers } = await materializeNodesForRun(
        runId,
        phaseId,
        task.blueprint.nodes.map((n, idx) => ({
          id: `${runId}_${n.id || `n${idx + 1}`}`,
          name: n.name,
          roleId: n.roleId,
          contextMode: n.contextMode,
          docKey: n.docKey,
          expectedDoc: n.expectedDoc,
          confirmAfter: n.confirmAfter,
          overrideModel: n.overrideModel,
          overrideEffort: n.overrideEffort,
        })),
      );
      if (blockers.length > 0) {
        const err = new Error(
          `PREFLIGHT_BLOCKED: ${blockers.map((b) => b.message).join('；')}`,
        ) as Error & { blockers?: PreflightBlocker[] };
        err.blockers = blockers;
        throw err;
      }

      const now = new Date().toISOString();
      await writeQueue.enqueue(() => {
        db.prepare(
          `update workflow_instances
           set status = 'running', pause_reason = null, blueprint_status = 'locked', updated_at = ?
           where id = ?`,
        ).run(now, runId);
      });

      launchBackground(runId, (sig) => executeSequentialNodes(runId, sig));
      return getTaskDetail(runId);
    },

    async saveTaskAsTemplate(runId, input) {
      const task = getTaskDetail(runId);
      const sourceNodes: LinearWorkflowNodeInput[] =
        task.blueprint?.nodes.length
          ? task.blueprint.nodes.map((n, idx) => ({
              id: n.id || `n${idx + 1}`,
              name: n.name,
              role: n.roleId,
              docKey: n.docKey,
              expectedDoc: n.expectedDoc,
              confirmAfter: n.confirmAfter,
              overrideModel: n.overrideModel,
              overrideEffort: n.overrideEffort,
              contextMode: n.contextMode ?? 'auto',
            }))
          : task.nodes.map((n, idx) => ({
              id: `n${idx + 1}`,
              name: n.name,
              role: n.role,
              docKey: n.docKey ?? undefined,
              expectedDoc: n.expectedDoc ?? undefined,
              confirmAfter: n.confirmAfter,
              contextMode: n.contextMode,
            }));

      const templateId = input.id?.trim() || slugifyId(input.name, 'tpl');
      const saved = saveLinearWorkflow(
        { repoPath, builtInWorkflowsDir },
        {
          id: templateId,
          name: input.name.trim(),
          description: input.description?.trim() || '由动态编排保存',
          nodes: sourceNodes,
        },
      );
      return { id: saved.id, name: saved.name };
    },

    async waitForIdle(runId) {
      if (runId) {
        const active = activeRuns.get(runId);
        if (active) await active.promise;
        return;
      }
      await Promise.all([...activeRuns.values()].map((a) => a.promise));
    },

    async shutdown() {
      for (const [runId, active] of activeRuns.entries()) {
        active.reason = 'cancel';
        active.controller.abort('shutdown');
        subprocessRegistry.killAll(runId, 'SIGTERM');
      }
      await Promise.allSettled([...activeRuns.values()].map((a) => a.promise));
    },
  };
}
