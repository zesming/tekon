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
        latestRun: latestRun ? mapWorkflow(latestRun, { db: context.db }) : null,
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
        ).map((row) => mapWorkflow(row, { db: context.db })),
      };
    },

    async pause(runInput: TokenRunInput) {
      assertSessionToken(context.projectContext, runInput.token);
      assertRunInScope(context.db, context.projectContext, runInput.runId);
      // M7 order: token → scope → write. SessionService does the CAS
      // running→paused (MUST-FIX1: no clobber of a concurrent terminal/cancel);
      // the router maps an illegal transition (e.g. passed→paused) to 400.
      const result = await context.sessionService.requestPause({
        runId: runInput.runId,
      });
      if (result.outcome === 'illegal-transition') {
        throw new ApiError(
          'BAD_REQUEST',
          `Cannot pause a run in status: ${result.workflowStatus}`,
        );
      }
      return {
        run: mapWorkflow(mustGetRun(context.db, runInput.runId), {
          db: context.db,
        }),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.jobId ? { jobId: result.jobId } : {}),
      };
    },

    async run(runInput: ProjectRunInput) {
      assertSessionToken(context.projectContext, runInput.token);
      const shapedDraft = runInput.demandShapePath
        ? readDraftShapeFile(
            assertDraftShapePathInScope(context, runInput.demandShapePath),
          )
        : null;
      // P0-03 (S7c): a shaped demand must be BOTH approved AND readyForRun
      // (openQuestions cleared). The approval state comes from the server-read
      // file, never a client boolean. Free-text runs (no shapePath) are exempt.
      if (shapedDraft && !shapedDraft.approved) {
        throw new ApiError(
          'BAD_REQUEST',
          'Draft shape must be approved before run.',
        );
      }
      if (shapedDraft && !shapedDraft.readyForRun) {
        throw new ApiError(
          'BAD_REQUEST',
          'Draft shape has open questions; resolve them (readyForRun) before run.',
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
      // S12: every synchronous validation stays before enqueue — a dirty base
      // must 400 here, not degrade into a background job failure.
      assertCleanBase(
        context.projectContext.projectRoot,
        Boolean(runInput.allowDirtyBase),
      );
      const workflowSpec = loadProjectWorkflowIfPresent(context, templateName);
      // 4a: SessionService owns the prepareRun → session → events → enqueue
      // orchestration. The router keeps token/scope, draft-shape validation,
      // clean-base, project-workflow loading, ApiError, and mapping. The
      // demand-shaped governance audit (P0-03 evidence, intentionally not a
      // session event) rides the onPrepared hook so it stays in the audit chain.
      const result = await context.sessionService.startRun({
        demandText,
        ...(workflowSpec ? { workflowSpec } : { templateName }),
        engine: {
          agent: runInput.agent ?? 'codex',
          allowDirtyBase: Boolean(runInput.allowDirtyBase),
          ...(runInput.timeoutMs !== undefined
            ? { timeoutMs: runInput.timeoutMs }
            : {}),
          ...(runInput.noProgressTimeoutMs !== undefined
            ? { noProgressTimeoutMs: runInput.noProgressTimeoutMs }
            : {}),
          ...(runInput.progressHeartbeatMs !== undefined
            ? { progressHeartbeatMs: runInput.progressHeartbeatMs }
            : {}),
        },
        onPrepared: shapedDraft
          ? async (runId) => {
              await context.audit.append({
                runId,
                type: 'run.demand-shaped',
                payload: {
                  shapePath: runInput.demandShapePath,
                  approved: shapedDraft.approved,
                  readyForRun: shapedDraft.readyForRun,
                },
              });
            }
          : undefined,
      });

      return {
        run: mapWorkflowFromDomain(result.workflow),
        sessionId: result.sessionId,
        jobId: result.jobId,
      };
    },

    async resume(runInput: TokenRunInput) {
      assertSessionToken(context.projectContext, runInput.token);
      assertRunInScope(context.db, context.projectContext, runInput.runId);
      // 4a: SessionService owns the resume orchestration (pending-decision
      // guard, M8 terminal guard, MF2 single-active-job guard, session backfill,
      // enqueue). The router maps each outcome to ApiError/response.
      const result = await context.sessionService.resumeRun({
        runId: runInput.runId,
      });
      if (result.outcome === 'pending-decisions') {
        throw new ApiError(
          'BAD_REQUEST',
          'Run has pending human decisions; approve or reject the gate first.',
        );
      }
      if (result.outcome === 'terminal') {
        throw new ApiError(
          'BAD_REQUEST',
          `Run is in terminal status: ${result.status}`,
        );
      }
      if (result.outcome === 'active-job') {
        throw new ApiError(
          'CONFLICT',
          'Run already has an active job; cancel it or wait for it to finish.',
        );
      }
      return {
        run: mapWorkflow(mustGetRun(context.db, runInput.runId), {
          db: context.db,
        }),
        sessionId: result.sessionId,
        jobId: result.jobId,
      };
    },

    async cancel(runInput: TokenRunInput) {
      assertSessionToken(context.projectContext, runInput.token);
      assertRunInScope(context.db, context.projectContext, runInput.runId);
      // 4a: SessionService owns the cancel orchestration. MF1: it is the single
      // emission point for agent/cancel-requested + agent/cancelled;
      // writeWorkflowTerminal is idempotent and runs FIRST (the CAS guard that
      // makes a racing engine completion throw instead of writing false passed).
      // The router only maps the result to a response.
      const result = await context.sessionService.requestCancel({
        runId: runInput.runId,
      });
      return {
        run: mapWorkflow(mustGetRun(context.db, runInput.runId), {
          db: context.db,
        }),
        ...(result.sessionId ? { sessionId: result.sessionId } : {}),
        ...(result.jobId ? { jobId: result.jobId } : {}),
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
