import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from 'node:fs';
import { join, relative, resolve } from 'node:path';

import {
  agentRequiresUnrestrictedNetwork,
  canonicalJson,
  computeRunPlanDigest,
  listWorkflowCatalog,
  loadWorkflowTemplate,
  loadWorkflowTemplateFile,
  projectRunPlan,
  readDraftShapeFile,
  renderDraftShapeForRun,
  runDshPreflight,
  type RunPlan,
  type WorkflowTemplate,
} from '@tekon/core';

import type {
  ServerContext,
  ProjectRunInput,
  ProjectCleanInput,
  TokenRunInput,
  WebRunEngineInput,
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
import { createProviderHealthService } from '../provider-health.js';
import {
  mapProject,
  mapWorkflow,
  mapWorkflowFromDomain,
} from '../mappers.js';

interface HealthCacheEntry {
  result: {
    credential: 'not-configured' | 'valid' | 'invalid';
    checkedAt: string;
    detail?: string;
    dshHeadless?: 'available' | 'unavailable';
  };
  cachedAt: number;
}

const HEALTH_CACHE_TTL_MS = 60_000;
const HEALTH_CACHE_MAX_ENTRIES = 128;
const DSH_HEALTH_PROBE_TIMEOUT_MS = 1_000;
const healthCache = new Map<string, HealthCacheEntry>();

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function cleanExpiredHealthCache(now: number): void {
  for (const [key, entry] of healthCache.entries()) {
    if (now - entry.cachedAt >= HEALTH_CACHE_TTL_MS) {
      healthCache.delete(key);
    }
  }
}

function setHealthCache(key: string, entry: HealthCacheEntry): void {
  if (healthCache.size >= HEALTH_CACHE_MAX_ENTRIES && !healthCache.has(key)) {
    const oldestKey = healthCache.keys().next().value;
    if (oldestKey !== undefined) {
      healthCache.delete(oldestKey);
    }
  }
  healthCache.set(key, entry);
}

async function probeProvider(): Promise<'available' | 'unavailable'> {
  try {
    // Health uses the same admission contract as a real run. A binary that
    // merely answers `--version` is not usable when its exact version, help
    // surface, composed governance rows, or host Node contract is incompatible.
    // A short per-probe budget keeps this status check responsive; actual run
    // admission retains the wider core default.
    await runDshPreflight('dsh', {
      probeTimeoutMs: DSH_HEALTH_PROBE_TIMEOUT_MS,
    });
    return 'available';
  } catch {
    return 'unavailable';
  }
}

export function createProjectRouter(
  context: ServerContext,
  options?: { probeProvider?: () => Promise<'available' | 'unavailable'> },
) {
  const providerHealthService = createProviderHealthService({
    probe: options?.probeProvider ?? probeProvider,
  });

  return {
    async list() {
      return listScopedProjects(context.db, context.projectContext).map(
        mapProject,
      );
    },

    async health(input?: { token?: string }) {
      // Credential health must use the same byte-for-byte token semantics as
      // authenticated RPCs. Trimming here would report a token as valid while
      // every mutation and provider-health request correctly rejects it.
      const token = input?.token;
      const tokenHash = token ? hashToken(token) : 'empty';
      const cacheKey = `${context.projectContext.sessionPath}:${tokenHash}`;
      const now = Date.now();
      cleanExpiredHealthCache(now);

      const cached = healthCache.get(cacheKey);
      if (cached && now - cached.cachedAt < HEALTH_CACHE_TTL_MS) {
        return cached.result;
      }

      let credential: 'not-configured' | 'valid' | 'invalid' = 'not-configured';
      let detail: string | undefined;

      if (!token) {
        credential = 'not-configured';
      } else {
        let expectedToken: string | undefined;
        try {
          const parsed = JSON.parse(
            readFileSync(context.projectContext.sessionPath, 'utf8'),
          ) as { token?: unknown };
          expectedToken =
            typeof parsed.token === 'string' ? parsed.token : undefined;
        } catch {
          expectedToken = undefined;
        }

        if (!expectedToken) {
          credential = 'not-configured';
          detail = 'Web session token is not configured on server';
        } else if (token === expectedToken) {
          credential = 'valid';
        } else {
          credential = 'invalid';
          detail = 'Session token does not match server configuration';
        }
      }

      const result = {
        credential,
        checkedAt: new Date().toISOString(),
        ...(detail ? { detail } : {}),
      };

      setHealthCache(cacheKey, { result, cachedAt: now });
      return result;
    },

    async providerHealth(input: { token: string; provider: 'dsh-headless' }) {
      assertSessionToken(context.projectContext, input.token);
      const tokenHash = hashToken(input.token);
      return await providerHealthService.check({
        scope: context.projectContext.sessionPath,
        tokenHash,
        provider: input.provider,
      });
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
      if (shapedDraft?.hasPlan && shapedDraft.planApproved !== true) {
        throw new ApiError(
          'BAD_REQUEST',
          'Draft has a generated plan that must be approved before run (tekon draft plan-approve).',
        );
      }
      const demandText = shapedDraft
        ? renderDraftShapeForRun(shapedDraft)
        : runInput.demandText.trim();
      if (!demandText) {
        throw new ApiError('BAD_REQUEST', 'Demand text is required.');
      }

      const isGoal = runInput.mode === 'goal';
      const allowDirtyBase = Boolean(runInput.allowDirtyBase);
      const resolvedProfile = runInput.profile ?? 'human-web';
      const resolvedAgent = runInput.agent ?? 'codex';
      assertCleanBase(context.projectContext.projectRoot, allowDirtyBase);

      const templateName = isGoal
        ? undefined
        : runInput.template?.trim() || 'standard-delivery';
      if (templateName) {
        assertSafeName(templateName, 'template');
      }

      let workflowSpec: WorkflowTemplate | null = null;
      let canonicalPlan: RunPlan | null = null;
      if (!isGoal) {
        if (!runInput.planDigest || runInput.planDigest.trim() === '') {
          throw new ApiError(
            'BAD_REQUEST',
            'PLAN_DIGEST_REQUIRED: planDigest is required for workflow runs',
          );
        }

        // Load exactly once. The same immutable object is used for digest
        // validation and prepareRun so a project YAML edit cannot win a
        // validation→execution TOCTOU race.
        workflowSpec = loadTemplate(context, templateName!);
        canonicalPlan = projectRunPlan(workflowSpec, {
          agent: resolvedAgent,
          mode: 'workflow',
          profile: resolvedProfile,
          allowDirtyBase,
          timeoutMs: runInput.timeoutMs,
          noProgressTimeoutMs: runInput.noProgressTimeoutMs,
          progressHeartbeatMs: runInput.progressHeartbeatMs,
          templateId: templateName,
        });
        const computedDigest =
          canonicalPlan.digest ?? computeRunPlanDigest(canonicalPlan);
        if (runInput.planDigest !== computedDigest) {
          throw new ApiError(
            'BAD_REQUEST',
            'PLAN_DIGEST_MISMATCH: Execution plan digest mismatch',
          );
        }
      }

      const requiresUnrestrictedNetwork = agentRequiresUnrestrictedNetwork(
        resolvedAgent,
      );
      if (
        requiresUnrestrictedNetwork &&
        runInput.acknowledgeUnrestrictedNetwork !== true
      ) {
        throw new ApiError('BAD_REQUEST', '联网不受限需知情确认');
      }

      const engineInput = {
        agent: resolvedAgent,
        allowDirtyBase,
        ...(runInput.timeoutMs !== undefined
          ? { timeoutMs: runInput.timeoutMs }
          : {}),
        ...(runInput.noProgressTimeoutMs !== undefined
          ? { noProgressTimeoutMs: runInput.noProgressTimeoutMs }
          : {}),
        ...(runInput.progressHeartbeatMs !== undefined
          ? { progressHeartbeatMs: runInput.progressHeartbeatMs }
          : {}),
        ...(runInput.acknowledgeUnrestrictedNetwork !== undefined
          ? {
              acknowledgeUnrestrictedNetwork:
                runInput.acknowledgeUnrestrictedNetwork,
            }
          : {}),
        ...(canonicalPlan
          ? {
              canonicalPlan,
              planDigest: canonicalPlan.digest,
              planSnapshot: canonicalJson(canonicalPlan),
            }
          : {}),
      } as WebRunEngineInput & {
        canonicalPlan?: RunPlan;
        planSnapshot?: string;
      };

      const result = await context.sessionService.startRun({
        demandText,
        ...(isGoal
          ? { mode: 'goal' as const }
          : {
              templateName,
              workflowSpec: workflowSpec!,
              planDigest: canonicalPlan!.digest,
            }),
        ...(runInput.profile ? { profile: runInput.profile } : {}),
        engine: engineInput,
        onPrepared:
          shapedDraft ||
          (requiresUnrestrictedNetwork && runInput.acknowledgeUnrestrictedNetwork)
            ? async (runId) => {
                if (shapedDraft) {
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
                if (
                  requiresUnrestrictedNetwork &&
                  runInput.acknowledgeUnrestrictedNetwork
                ) {
                  await context.audit.append({
                    runId,
                    type: 'run.network-acknowledged',
                    payload: {
                      agent: resolvedAgent,
                      acknowledgeUnrestrictedNetwork: true,
                    },
                  });
                }
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

      const run = mustGetRun(context.db, runInput.runId);
      // Clean evidence covers every active job kind, including delayed
      // readiness/delivery automation. JobRepository.findActiveByRunId is
      // intentionally limited to workflow controls and would omit those.
      const activeJob = context.db
        .prepare(
          `select j.id from jobs j
           join sessions s on s.id = j.session_id
           where s.run_id = ?
             and j.status in ('queued', 'running', 'paused', 'cancelling')
           order by j.created_at desc, j.id desc
           limit 1`,
        )
        .get(runInput.runId) as { id: string } | undefined;
      const leases = await context.repositories.listWorktreeLeases(
        runInput.runId,
      );
      const unreleasedLeaseIds = leases
        .filter((lease) => !lease.releasedAt)
        .map((lease) => lease.id);

      try {
        await context.audit.append({
          runId: runInput.runId,
          type: 'project.clean.suspended',
          payload: {
            reason: 'CLEAN_SUSPENDED',
            runStatus: run.status,
            ...(activeJob?.id ? { activeJobId: activeJob.id } : {}),
            unreleasedLeaseIds,
          },
        });
      } catch {
        throw new ApiError(
          'INTERNAL_ERROR',
          'CLEAN_AUDIT_FAILED: unable to record suspended clean request',
        );
      }

      throw new ApiError(
        'CONFLICT',
        'CLEAN_SUSPENDED: project.clean is suspended pending lifecycle-safe purge',
      );
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
): Array<{ id: string; name: string; builtin?: boolean; path?: string }> {
  return listWorkflowCatalog({
    projectWorkflowsDir: context.projectContext.workflowsDir,
  });
}

function loadTemplate(context: ServerContext, name: string): WorkflowTemplate {
  const custom = loadProjectWorkflowIfPresent(context, name);
  if (custom) {
    return custom;
  }
  try {
    return loadWorkflowTemplate({ name });
  } catch {
    throw new ApiError('NOT_FOUND', `Workflow template not found: ${name}`);
  }
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
