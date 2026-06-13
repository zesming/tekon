import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  createCommandGateway,
  createGateEngine,
  createWorkflowEngine,
  createWorktreeManager,
  loadWorkflowTemplateFile,
  readDraftShapeFile,
  renderDraftShapeForRun,
  type WorkflowTemplate,
} from '@tekon/core';

import type {
  ServerContext,
  ProjectRunInput,
  ProjectCleanInput,
  TokenRunInput,
} from '../context.js';
import { ApiError } from '../errors.js';
import { assertSafeName, assertSessionToken } from '../common.js';
import {
  assertRunInScope,
  count,
  firstProjectOrFallback,
  latestScopedRun,
  listRunsForScopedProjects,
  listScopedProjects,
  mustGetRun,
  pendingDecisionCount,
} from '../queries.js';
import {
  mapProject,
  mapWorkflow,
  mapWorkflowFromDomain,
} from '../mappers.js';
import {
  createWebAgentRuntime,
  providerRuntimeFromRunInput,
  resumeWorkflowRun,
} from '../agents.js';

export function createProjectRouter(context: ServerContext) {
  return {
    async list() {
      return listScopedProjects(context.db, context.projectContext).map(
        mapProject,
      );
    },

    async overview() {
      const latest = latestScopedRun(context.db, context.projectContext);
      const project =
        latest?.project ??
        firstProjectOrFallback(context.db, context.projectContext);
      const latestRun = latest?.run ?? null;
      return {
        project: mapProject(project),
        latestRun: latestRun ? mapWorkflow(latestRun) : null,
        counts: {
          artifacts: latestRun
            ? count(context.db, 'artifacts', latestRun.id)
            : 0,
          gates: latestRun
            ? count(context.db, 'gate_results', latestRun.id)
            : 0,
          audit: latestRun
            ? count(context.db, 'audit_events', latestRun.id)
            : 0,
          pendingApprovals: latestRun
            ? pendingDecisionCount(context.db, latestRun.id)
            : 0,
          roles: listRoles(context).length,
          workflows: listWorkflows(context).length,
        },
      };
    },

    async detail(detailInput: { projectId: string }) {
      const scopedProjects = listScopedProjects(
        context.db,
        context.projectContext,
      );
      const project =
        scopedProjects.find(
          (candidate) => candidate.id === detailInput.projectId,
        ) ??
        (detailInput.projectId === 'local' && scopedProjects.length === 0
          ? firstProjectOrFallback(context.db, context.projectContext)
          : null);
      if (!project) {
        throw new ApiError(
          'NOT_FOUND',
          `Project not found: ${detailInput.projectId}`,
        );
      }
      return {
        project: mapProject(project),
        runs: listRunsForScopedProjects(
          context.db,
          context.projectContext,
        ).map(mapWorkflow),
      };
    },

    async pause(runInput: TokenRunInput) {
      assertSessionToken(context.projectContext, runInput.token);
      assertRunInScope(context.db, context.projectContext, runInput.runId);
      await context.repositories.updateWorkflowInstanceStatus(
        runInput.runId,
        'paused',
      );
      return {
        run: mapWorkflow(mustGetRun(context.db, runInput.runId)),
      };
    },

    async run(runInput: ProjectRunInput) {
      assertSessionToken(context.projectContext, runInput.token);
      const shapedDraft = runInput.demandShapePath
        ? readDraftShapeFile(
            assertDraftShapePathInScope(context, runInput.demandShapePath),
          )
        : null;
      if (shapedDraft && !shapedDraft.approved) {
        throw new ApiError(
          'BAD_REQUEST',
          'Draft shape must be approved before run.',
        );
      }
      const demandText = shapedDraft
        ? renderDraftShapeForRun(shapedDraft)
        : runInput.demandText.trim();
      if (!demandText) {
        throw new ApiError('BAD_REQUEST', 'Demand text is required.');
      }
      const templateName = runInput.template?.trim() || 'standard-delivery';
      assertSafeName(templateName, 'template');
      const gateway = createCommandGateway({
        repositories: context.repositories,
      });
      const agentRuntime = createWebAgentRuntime({
        agent: runInput.agent ?? 'codex',
        repoPath: context.projectContext.projectRoot,
        gateway,
        runtime: providerRuntimeFromRunInput(runInput),
      });
      assertCleanBase(
        context.projectContext.projectRoot,
        Boolean(runInput.allowDirtyBase),
      );
      const workflowSpec = loadProjectWorkflowIfPresent(context, templateName);
      const engine = createWorkflowEngine({
        repoPath: context.projectContext.projectRoot,
        dataDir: '.tekon',
        repositories: context.repositories,
        audit: context.audit,
        adapter: agentRuntime.adapter,
        agentProvider: agentRuntime.provider,
        agentConfigSummary: agentRuntime.configSummary,
        allowDirtyBase: Boolean(runInput.allowDirtyBase),
        gateEngine: createGateEngine({
          repositories: context.repositories,
          gateway,
        }),
        worktreeManager: createWorktreeManager({
          repositories: context.repositories,
          gateway,
        }),
      });
      const result = await engine.startRun({
        demandText,
        mode: 'template',
        ...(workflowSpec ? { workflowSpec } : { templateName }),
      });
      return { run: mapWorkflowFromDomain(result.workflow) };
    },

    async resume(runInput: TokenRunInput) {
      assertSessionToken(context.projectContext, runInput.token);
      assertRunInScope(context.db, context.projectContext, runInput.runId);
      const pendingHuman = await context.repositories.listHumanDecisions(
        runInput.runId,
      );
      if (pendingHuman.some((decision) => decision.status === 'pending')) {
        throw new ApiError(
          'BAD_REQUEST',
          'Run has pending human decisions; approve or reject the gate first.',
        );
      }
      const result = await resumeWorkflowRun({
        context: context.projectContext,
        repositories: context.repositories,
        audit: context.audit,
        runId: runInput.runId,
      });
      return { run: mapWorkflowFromDomain(result.workflow) };
    },

    async cancel(runInput: TokenRunInput) {
      assertSessionToken(context.projectContext, runInput.token);
      assertRunInScope(context.db, context.projectContext, runInput.runId);
      await context.repositories.updateWorkflowInstanceStatus(
        runInput.runId,
        'cancelled',
      );
      return {
        run: mapWorkflow(mustGetRun(context.db, runInput.runId)),
      };
    },

    async clean(runInput: ProjectCleanInput) {
      assertSessionToken(context.projectContext, runInput.token);
      if (runInput.confirm !== 'delete-run-dir') {
        throw new ApiError(
          'BAD_REQUEST',
          "project.clean requires confirm: 'delete-run-dir'.",
        );
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(runInput.runId)) {
        throw new ApiError('BAD_REQUEST', 'Invalid runId format');
      }
      assertRunInScope(context.db, context.projectContext, runInput.runId);
      const runDir = join(
        context.projectContext.dataDir,
        'runs',
        runInput.runId,
      );
      const removedRunDir = existsSync(runDir);
      if (removedRunDir) {
        rmSync(runDir, { recursive: true, force: true });
      }
      return { removedRunDir };
    },
  };
}

function listRoles(
  context: ServerContext,
): Array<{ id: string; name: string }> {
  const rolesDir = context.projectContext.rolesDir;
  if (!existsSync(rolesDir)) {
    return [];
  }

  return readdirSync(rolesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      id: entry.name,
      name: entry.name.toUpperCase(),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function listWorkflows(
  context: ServerContext,
): Array<{ id: string; name: string; path: string }> {
  const workflowsDir = context.projectContext.workflowsDir;
  if (!existsSync(workflowsDir)) {
    return [];
  }

  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => {
      const path = join(workflowsDir, entry.name);
      const content = readFileSync(path, 'utf8');
      return {
        id:
          extractYamlScalar(content, 'id') ??
          entry.name.replace(/\.ya?ml$/u, ''),
        name: extractYamlScalar(content, 'name') ?? entry.name,
        path,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function extractYamlScalar(content: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(content);
  return match?.[1]?.trim().replace(/^["']|["']$/gu, '');
}

function loadProjectWorkflowIfPresent(
  context: ServerContext,
  name: string,
): WorkflowTemplate | null {
  for (const extension of ['.yaml', '.yml']) {
    const workflowPath = join(
      context.projectContext.workflowsDir,
      `${name}${extension}`,
    );
    if (existsSync(workflowPath)) {
      return loadWorkflowTemplateFile(workflowPath);
    }
  }
  return null;
}

function assertCleanBase(repoPath: string, allowDirtyBase: boolean): void {
  let status: string;
  try {
    status = execFileSync('git', ['status', '--porcelain'], {
      cwd: repoPath,
      encoding: 'utf8',
    });
  } catch (error) {
    throw new ApiError(
      'BAD_REQUEST',
      `Cannot inspect git status for Web run: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const meaningfulDirtyLines = status
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith('?? .tekon/'));

  if (meaningfulDirtyLines.length > 0 && !allowDirtyBase) {
    throw new ApiError(
      'BAD_REQUEST',
      'Dirty base worktree requires explicit allowDirtyBase before Web run.',
    );
  }
}

function assertDraftShapePathInScope(
  context: ServerContext,
  shapePath: string,
): string {
  const resolvedPath = resolve(shapePath);
  const draftsDir = assertDraftShapeStorageInScope(context, {
    create: false,
  });
  const pathFromDrafts = relative(draftsDir, resolvedPath);
  if (
    pathFromDrafts.startsWith('..') ||
    pathFromDrafts === '' ||
    pathFromDrafts.includes('..') ||
    !pathFromDrafts.endsWith('.json')
  ) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (!existsSync(draftsDir) || !existsSync(resolvedPath)) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (lstatSync(resolvedPath).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  const expectedDraftsDir = realpathSync(draftsDir);
  const realPathFromDrafts = relative(
    expectedDraftsDir,
    realpathSync(resolvedPath),
  );
  if (realPathFromDrafts.startsWith('..') || realPathFromDrafts === '') {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  return resolvedPath;
}

function assertDraftShapeStorageInScope(
  context: ServerContext,
  options: { create: boolean },
): string {
  const dataDir = resolve(context.projectContext.dataDir);
  const draftsDir = resolve(dataDir, 'drafts');
  if (!existsSync(dataDir)) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (lstatSync(dataDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  const expectedDataDir = resolve(
    realpathSync(context.projectContext.projectRoot),
    '.tekon',
  );
  const realDataDir = realpathSync(dataDir);
  if (realDataDir !== expectedDataDir) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (existsSync(draftsDir) && lstatSync(draftsDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (options.create) {
    mkdirSync(draftsDir, { recursive: true });
  }
  if (!existsSync(draftsDir)) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (lstatSync(draftsDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  if (realpathSync(draftsDir) !== resolve(realDataDir, 'drafts')) {
    throw new ApiError('BAD_REQUEST', 'Draft shape path is out of scope.');
  }
  return draftsDir;
}
