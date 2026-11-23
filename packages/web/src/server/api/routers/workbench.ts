import {
  deleteCustomRole,
  deleteCustomWorkflow,
  duplicateLinearWorkflow,
  duplicateRoleConfig,
  getLinearWorkflow,
  listLinearWorkflows,
  listRolesDetailed,
  resetBuiltInRole,
  resetBuiltInWorkflow,
  saveLinearWorkflow,
  saveRoleConfig,
  type WorkbenchPreferences,
  type WorkbenchRuntime,
} from '@tekon/core';

import { ApiError } from '../errors.js';

function mapWorkbenchError(error: unknown): never {
  if (error instanceof ApiError) throw error;
  const msg = error instanceof Error ? error.message : String(error);
  if (
    msg.startsWith('TASK_NOT_FOUND') ||
    msg.startsWith('NODE_NOT_FOUND') ||
    msg.startsWith('DOCUMENT_NOT_FOUND') ||
    msg.startsWith('ARCHIVE_NOT_FOUND') ||
    msg.startsWith('HANDOFF_NOT_FOUND')
  ) {
    throw new ApiError('NOT_FOUND', msg);
  }
  if (
    msg.startsWith('PREFLIGHT_BLOCKED') ||
    msg.startsWith('ROLE_IN_USE') ||
    msg.startsWith('ROLE_BUILTIN_PROTECTED') ||
    msg.startsWith('WORKFLOW_BUILTIN_PROTECTED') ||
    msg.startsWith('LAST_NODE_RUNNING') ||
    msg.startsWith('TASK_TERMINAL') ||
    msg.startsWith('TASK_CANCELLED') ||
    msg.startsWith('BLUEPRINT_NOT_EDITABLE') ||
    msg.startsWith('BLUEPRINT_NOT_READY') ||
    msg.startsWith('NO_PENDING_CHECKPOINT') ||
    msg.startsWith('TASK_NOT_COMPLETED') ||
    msg.startsWith('TASK_ALREADY_RUNNING') ||
    msg.startsWith('TASK_NOT_RESUMABLE') ||
    msg.startsWith('TASK_NOT_PAUSABLE') ||
    msg.startsWith('LEGACY_TASK_READONLY')
  ) {
    throw new ApiError('CONFLICT', msg);
  }
  if (msg.startsWith('FOLLOWUP_FAILED')) {
    throw new ApiError('INTERNAL_ERROR', msg);
  }
  throw new ApiError('BAD_REQUEST', msg);
}

export interface CreateWorkbenchRoutersDeps {
  runtime: WorkbenchRuntime;
  repoPath: string;
  builtInRolesDir: string;
  builtInWorkflowsDir: string;
  userHome?: string;
}

export function createWorkbenchRouters(deps: CreateWorkbenchRoutersDeps) {
  const { runtime, repoPath, builtInRolesDir, builtInWorkflowsDir, userHome } =
    deps;
  const roleCtx = {
    repoPath,
    builtInRolesDir,
    builtInWorkflowsDir,
    userHome,
  };
  const wfCtx = { repoPath, builtInWorkflowsDir };
  const assertWorkbenchTask = (runId: string) => {
    const task = runtime.getTaskDetail(runId);
    if (task.executor !== 'workbench') {
      throw new Error(
        'LEGACY_TASK_READONLY: 旧版执行器创建的任务在文档与上下文面板为只读，不可执行工作台写操作。',
      );
    }
  };

  return {
    agent: {
      async list() {
        return runtime.getAgentsSnapshot();
      },
      async refresh() {
        return runtime.refreshAgents();
      },
    },

    prefs: {
      async get() {
        return {
          workspace: runtime.getWorkspaceInfo(),
          prefs: runtime.contextManager.getPreferences(),
        };
      },
      async update(input: Partial<WorkbenchPreferences>) {
        const prefs = await runtime.contextManager.updatePreferences(input);
        return { workspace: runtime.getWorkspaceInfo(), prefs };
      },
    },

    roleExtensions: {
      async listDetailed(input?: { includeDelivery?: boolean }) {
        try {
          return { roles: listRolesDetailed(roleCtx, input) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async save(input: {
        id: string;
        name?: string;
        description?: string;
        driver?: string;
        model?: string;
        effort?: string;
        isolated?: boolean;
        systemPrompt: string;
      }) {
        try {
          const resolvedAgent = input.driver
            ? (await runtime.getAgentsSnapshot()).agents.find(
                (a) => a.id === input.driver,
              )
            : undefined;
          return saveRoleConfig(roleCtx, input, { resolvedAgent });
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async duplicate(input: {
        sourceId: string;
        newId?: string;
        newName?: string;
      }) {
        try {
          return {
            role: duplicateRoleConfig(
              roleCtx,
              input.sourceId,
              input.newId,
              input.newName,
            ),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async delete(input: { id: string }) {
        try {
          const prefs = runtime.contextManager.getPreferences();
          deleteCustomRole(roleCtx, input.id, {
            defaultOrchestrator: prefs.defaultOrchestrator,
          });
          return { deleted: true as const };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async resetBuiltIn(input: { id: string }) {
        try {
          const snap = await runtime.getAgentsSnapshot();
          const result = resetBuiltInRole(roleCtx, input.id, {
            resolvedAgent: snap.agents.find(
              (a) => a.status === 'ready' && a.executable !== false,
            ),
          });
          return result;
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
    },

    workflowExtensions: {
      async listDetailed(input?: { includeDelivery?: boolean }) {
        try {
          return { workflows: listLinearWorkflows(wfCtx, input) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async get(input: { id: string }) {
        try {
          return { workflow: getLinearWorkflow(wfCtx, input.id) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async save(input: {
        id: string;
        name: string;
        description?: string;
        nodes: Parameters<typeof saveLinearWorkflow>[1]['nodes'];
      }) {
        try {
          return { workflow: saveLinearWorkflow(wfCtx, input) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async duplicate(input: {
        sourceId: string;
        newId?: string;
        newName?: string;
      }) {
        try {
          return {
            workflow: duplicateLinearWorkflow(
              wfCtx,
              input.sourceId,
              input.newId,
              input.newName,
            ),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async delete(input: { id: string }) {
        try {
          deleteCustomWorkflow(wfCtx, input.id);
          return { deleted: true as const };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async resetBuiltIn(input: { id: string }) {
        try {
          return { workflow: resetBuiltInWorkflow(wfCtx, input.id) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
    },

    task: {
      async list(input?: {
        filter?: 'all' | 'running' | 'attention' | 'done';
        q?: string;
      }) {
        return {
          workspace: runtime.getWorkspaceInfo(),
          tasks: runtime.listTasks(input),
        };
      },
      async get(input: { runId: string }) {
        try {
          return { task: runtime.getTaskDetail(input.runId) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async create(input: {
        mode: 'static' | 'dynamic';
        templateId?: string;
        prompt: string;
        attachments?: Array<{ name: string; content: string }>;
      }) {
        try {
          return await runtime.createTask(input);
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async pause(input: { runId: string }) {
        try {
          return { task: await runtime.pauseTask(input.runId) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async resume(input: { runId: string }) {
        try {
          return { task: await runtime.resumeTask(input.runId) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async cancel(input: { runId: string }) {
        try {
          return { task: await runtime.cancelTask(input.runId) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async appendConstraint(input: { runId: string; text: string }) {
        try {
          return {
            task: await runtime.appendConstraint(input.runId, input.text),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async approveCheckpoint(input: { runId: string }) {
        try {
          return { task: await runtime.approveCheckpoint(input.runId) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async reworkFromNode(input: {
        runId: string;
        targetNodeId: string;
        note: string;
      }) {
        try {
          return {
            task: await runtime.reworkFromNode(
              input.runId,
              input.targetNodeId,
              input.note,
            ),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async retryNode(input: {
        runId: string;
        nodeId: string;
        override?: { driver?: string; model?: string; effort?: string };
      }) {
        try {
          return {
            task: await runtime.retryNode(
              input.runId,
              input.nodeId,
              input.override,
            ),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async followUp(input: {
        runId: string;
        roleId?: string;
        prompt: string;
      }) {
        try {
          return {
            task: await runtime.followUp(input.runId, {
              roleId: input.roleId,
              prompt: input.prompt,
            }),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async updateBlueprint(input: {
        runId: string;
        nodes: Parameters<WorkbenchRuntime['updateBlueprint']>[1]['nodes'];
      }) {
        try {
          return {
            task: await runtime.updateBlueprint(input.runId, {
              nodes: input.nodes,
            }),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async replanBlueprint(input: { runId: string; instruction?: string }) {
        try {
          return {
            task: await runtime.replanBlueprint(input.runId, input.instruction),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async confirmBlueprint(input: { runId: string }) {
        try {
          return { task: await runtime.confirmBlueprint(input.runId) };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async saveAsTemplate(input: {
        runId: string;
        id?: string;
        name: string;
        description?: string;
      }) {
        try {
          return await runtime.saveTaskAsTemplate(input.runId, input);
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
    },

    doc: {
      async list(input: { runId: string }) {
        return { documents: runtime.contextManager.listRunDocuments(input.runId) };
      },
      async get(input: { runId: string; docId: string; version?: number }) {
        try {
          return runtime.contextManager.getDocumentContent(
            input.runId,
            input.docId,
            input.version,
          );
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async diff(input: {
        runId: string;
        docKey: string;
        fromVersion: number;
        toVersion: number;
      }) {
        try {
          return runtime.contextManager.diffDocuments(
            input.runId,
            input.docKey,
            input.fromVersion,
            input.toVersion,
          );
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async togglePin(input: { runId: string; docId: string }) {
        try {
          assertWorkbenchTask(input.runId);
          return {
            document: await runtime.contextManager.toggleDocumentPin(
              input.runId,
              input.docId,
            ),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async promoteFromHandoff(input: {
        runId: string;
        nodeId: string;
        title?: string;
      }) {
        try {
          assertWorkbenchTask(input.runId);
          return {
            document: await runtime.contextManager.promoteHandoffToDocument(input),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async export(input: { runId: string; docId: string }) {
        try {
          return runtime.contextManager.exportDocument(input.runId, input.docId);
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
    },

    context: {
      async inspectNode(input: { runId: string; nodeId: string }) {
        try {
          return {
            context: runtime.contextManager.inspectNodeContext(input),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async setNodeReuseMode(input: {
        runId: string;
        roleId: string;
        reuseMode: 'reuse' | 'reset';
      }) {
        try {
          assertWorkbenchTask(input.runId);
          await runtime.contextManager.setRoleSessionReuseMode(
            input.runId,
            input.roleId,
            input.reuseMode,
          );
          return { updated: true as const };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async compact(input: { runId: string }) {
        try {
          assertWorkbenchTask(input.runId);
          return await runtime.contextManager.compactContext(input.runId);
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async listArchives(input: { runId: string }) {
        return { archives: runtime.contextManager.listArchives(input.runId) };
      },
      async getArchive(input: { runId: string; archiveId: string }) {
        try {
          return runtime.contextManager.getArchiveContent(
            input.runId,
            input.archiveId,
          );
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
      async toggleArchiveMount(input: { runId: string; archiveId: string }) {
        try {
          assertWorkbenchTask(input.runId);
          return {
            archive: await runtime.contextManager.toggleArchiveMount(
              input.runId,
              input.archiveId,
            ),
          };
        } catch (err) {
          mapWorkbenchError(err);
        }
      },
    },
  };
}
