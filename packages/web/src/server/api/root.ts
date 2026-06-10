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
  approveDemandShape,
  createPullRequestPreparation,
  createAuditLogger,
  createClaudeCodeAdapter,
  createCommandGateway,
  createCodexAdapter,
  createGateEngine,
  createHumanApprovalSummary,
  createMockAgentAdapter,
  createRepositories,
  createScmDelivery,
  createWorkReviewSurface,
  createWorkflowEngine,
  createWorktreeManager,
  readDemandShapeFile,
  renderDemandShapeForRun,
  shapeDemand,
  evaluateHumanApprovalSummary,
  writeDemandShapeFile,
  writeDemandShapeFiles,
  agentAdapterConfigSchema,
  loadWorkflowTemplateFile,
  type AgentAdapter,
  type AgentAdapterConfig,
  type WorkflowTemplate,
  type CommandGateway,
  openTekonDatabase,
  type TekonDatabase,
  type RunProviderConfig,
  type WorkflowInstance,
} from '@tekon/core';

import {
  assertProjectDatabaseExists,
  createProjectContext,
  type ResolveProjectRootInput,
  type WebProjectContext,
} from '../project-context.js';
import { ApiError } from './errors.js';

interface ProjectRow {
  id: string;
  name: string;
  repo_path: string;
  created_at: string;
}

interface WorkflowRow {
  id: string;
  project_id: string;
  demand_id: string;
  status: string;
  current_node_id: string | null;
  created_at: string;
  updated_at: string;
}

interface GateRow {
  id: string;
  run_id: string;
  node_id: string;
  gate_type: string;
  status: string;
  output_path: string | null;
  duration_ms: number;
  retries: number;
  fix_attempt_id: string | null;
  failure_classification: string | null;
  created_at: string;
}

interface NodeRow {
  id: string;
  run_id: string;
  phase_id: string | null;
  role: string;
  status: string;
  gates: string;
  dependencies: string;
  created_at: string;
  updated_at: string;
}

interface ArtifactRow {
  id: string;
  run_id: string;
  node_id: string;
  type: string;
  version: number;
  path: string;
  sha256: string;
  size_bytes: number;
  summary: string | null;
  created_at: string;
}

interface HumanDecisionRow {
  id: string;
  run_id: string;
  node_id: string;
  gate_result_id: string | null;
  status: string;
  actor: string | null;
  note: string | null;
  created_at: string;
  decided_at: string | null;
}

export interface ApiCaller {
  demand: {
    shape(input: DemandShapeInput): Promise<{
      shape: ReturnType<typeof shapeDemand>;
      shapePath: string;
      reviewPath: string;
      runText: string;
    }>;
    approve(input: DemandApproveInput): Promise<{
      shape: ReturnType<typeof shapeDemand>;
      shapePath: string;
    }>;
  };
  project: {
    list(): Promise<
      { id: string; name: string; repoPath: string; createdAt: string }[]
    >;
    overview(): Promise<{
      project: ReturnType<typeof mapProject>;
      latestRun: ReturnType<typeof mapWorkflow> | null;
      counts: {
        artifacts: number;
        gates: number;
        audit: number;
        pendingApprovals: number;
        roles: number;
        workflows: number;
      };
    }>;
    detail(input: { projectId: string }): Promise<{
      project: ReturnType<typeof mapProject>;
      runs: ReturnType<typeof mapWorkflow>[];
    }>;
    pause(
      input: TokenRunInput,
    ): Promise<{ run: ReturnType<typeof mapWorkflow> }>;
    run(
      input: ProjectRunInput,
    ): Promise<{ run: ReturnType<typeof mapWorkflowFromDomain> }>;
    resume(
      input: TokenRunInput,
    ): Promise<{ run: ReturnType<typeof mapWorkflow> }>;
    cancel(
      input: TokenRunInput,
    ): Promise<{ run: ReturnType<typeof mapWorkflow> }>;
    clean(input: TokenRunInput): Promise<{ removedRunDir: boolean }>;
  };
  delivery: {
    prepare(input: TokenRunInput): Promise<{
      runId: string;
      branch: string;
      baseBranch: string;
      packagePath: string;
      prBodyPath: string;
      requiresHumanApproval: true;
    }>;
    createPr(input: DeliveryCreatePrInput): Promise<{
      runId: string;
      deliveryStatus: string;
      requiresHumanApproval: boolean;
      prUrl: string | null;
      failureStage: string | null;
      lastError: string | null;
      branch: string | null;
      baseBranch: string | null;
    }>;
  };
  artifact: {
    list(input: {
      runId: string;
    }): Promise<{ artifacts: ReturnType<typeof mapArtifact>[] }>;
  };
  gate: {
    list(input: { runId: string }): Promise<{
      gates: ReturnType<typeof mapGate>[];
      pendingDecisions: ReturnType<typeof mapHumanDecision>[];
    }>;
    approve(
      input: DecisionInput,
    ): Promise<{ decision: ReturnType<typeof mapHumanDecision> }>;
    reject(
      input: DecisionInput,
    ): Promise<{ decision: ReturnType<typeof mapHumanDecision> }>;
  };
  audit: {
    list(input: {
      runId: string;
      nodeId?: string;
      gateId?: string;
      role?: string;
    }): Promise<{
      verification: { valid: true } | { valid: false; brokenEventId: string };
      events: ReturnType<typeof mapAuditEvent>[];
    }>;
  };
  review: {
    get(input: {
      runId: string;
      maxContentChars?: number;
    }): Promise<Awaited<ReturnType<typeof createWorkReviewSurface>>>;
  };
  role: {
    list(): Promise<{
      roles: Array<{ id: string; name: string; systemPrompt?: string }>;
    }>;
  };
  workflow: {
    list(): Promise<{
      workflows: Array<{ id: string; name: string; path: string }>;
    }>;
  };
  close(): Promise<void>;
}

interface TokenRunInput {
  runId: string;
  token: string;
}

interface ProjectRunInput {
  demandText: string;
  token: string;
  template?: string;
  agent?: string;
  allowDirtyBase?: boolean;
  demandShapePath?: string;
}

interface DemandShapeInput {
  demandText: string;
  token: string;
}

interface DemandApproveInput {
  shapePath: string;
  token: string;
  actor?: string;
}

interface DeliveryCreatePrInput extends TokenRunInput {
  approveHuman?: boolean;
}

interface DecisionInput {
  runId: string;
  decisionId: string;
  actor: string;
  note?: string;
  token: string;
}

export async function createApiCaller(
  input: ResolveProjectRootInput,
): Promise<ApiCaller> {
  const context = createProjectContext(input);
  assertProjectDatabaseExists(context);
  const db = openTekonDatabase({ filename: context.dbPath });
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });

  const caller: ApiCaller = {
    demand: {
      async shape(shapeInput) {
        assertSessionToken(context, shapeInput.token);
        const shape = shapeDemand({ text: shapeInput.demandText });
        assertDemandShapeStorageInScope(context, { create: true });
        const paths = writeDemandShapeFiles({
          repoPath: context.projectRoot,
          shape,
        });
        return {
          shape,
          shapePath: paths.jsonPath,
          reviewPath: paths.markdownPath,
          runText: renderDemandShapeForRun(shape),
        };
      },

      async approve(approveInput) {
        assertSessionToken(context, approveInput.token);
        const shapePath = assertDemandShapePathInScope(
          context,
          approveInput.shapePath,
        );
        const approved = approveDemandShape(readDemandShapeFile(shapePath), {
          actor: approveInput.actor ?? 'web',
        });
        writeDemandShapeFile(shapePath, approved);
        return {
          shape: approved,
          shapePath,
        };
      },
    },

    project: {
      async list() {
        return listScopedProjects(db, context).map(mapProject);
      },

      async overview() {
        const latest = latestScopedRun(db, context);
        const project = latest?.project ?? firstProjectOrFallback(db, context);
        const latestRun = latest?.run ?? null;
        return {
          project: mapProject(project),
          latestRun: latestRun ? mapWorkflow(latestRun) : null,
          counts: {
            artifacts: latestRun ? count(db, 'artifacts', latestRun.id) : 0,
            gates: latestRun ? count(db, 'gate_results', latestRun.id) : 0,
            audit: latestRun ? count(db, 'audit_events', latestRun.id) : 0,
            pendingApprovals: latestRun
              ? pendingDecisionCount(db, latestRun.id)
              : 0,
            roles: listRoles(context).length,
            workflows: listWorkflows(context).length,
          },
        };
      },

      async detail(detailInput) {
        const scopedProjects = listScopedProjects(db, context);
        const project =
          scopedProjects.find(
            (candidate) => candidate.id === detailInput.projectId,
          ) ??
          (detailInput.projectId === 'local' && scopedProjects.length === 0
            ? firstProjectOrFallback(db, context)
            : null);
        if (!project) {
          throw new ApiError(
            'NOT_FOUND',
            `Project not found: ${detailInput.projectId}`,
          );
        }
        return {
          project: mapProject(project),
          runs: listRunsForScopedProjects(db, context).map(mapWorkflow),
        };
      },

      async pause(runInput) {
        assertSessionToken(context, runInput.token);
        assertRunInScope(db, context, runInput.runId);
        await repositories.updateWorkflowInstanceStatus(
          runInput.runId,
          'paused',
        );
        return { run: mapWorkflow(mustGetRun(db, runInput.runId)) };
      },

      async run(runInput) {
        assertSessionToken(context, runInput.token);
        const shapedDemand = runInput.demandShapePath
          ? readDemandShapeFile(
              assertDemandShapePathInScope(context, runInput.demandShapePath),
            )
          : null;
        if (shapedDemand && !shapedDemand.approved) {
          throw new ApiError(
            'BAD_REQUEST',
            'Demand shape must be approved before run.',
          );
        }
        const demandText = shapedDemand
          ? renderDemandShapeForRun(shapedDemand)
          : runInput.demandText.trim();
        if (!demandText) {
          throw new ApiError('BAD_REQUEST', 'Demand text is required.');
        }
        const templateName =
          runInput.template?.trim() ||
          shapedDemand?.recommendedTemplate ||
          'standard-feature';
        assertSafeName(templateName, 'template');
        const gateway = createCommandGateway({ repositories });
        const agentRuntime = createWebAgentRuntime({
          agent: runInput.agent ?? 'mock',
          repoPath: context.projectRoot,
          gateway,
        });
        assertCleanBase(context.projectRoot, Boolean(runInput.allowDirtyBase));
        const workflowSpec = loadProjectWorkflowIfPresent(
          context,
          templateName,
        );
        const engine = createWorkflowEngine({
          repoPath: context.projectRoot,
          dataDir: '.tekon',
          repositories,
          audit,
          adapter: agentRuntime.adapter,
          agentProvider: agentRuntime.provider,
          agentConfigSummary: agentRuntime.configSummary,
          allowDirtyBase: Boolean(runInput.allowDirtyBase),
          gateEngine: createGateEngine({ repositories, gateway }),
          worktreeManager: createWorktreeManager({
            repositories,
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

      async resume(runInput) {
        assertSessionToken(context, runInput.token);
        assertRunInScope(db, context, runInput.runId);
        const pendingHuman = await repositories.listHumanDecisions(
          runInput.runId,
        );
        if (pendingHuman.some((decision) => decision.status === 'pending')) {
          throw new ApiError(
            'BAD_REQUEST',
            'Run has pending human decisions; approve or reject the gate first.',
          );
        }
        const result = await resumeWorkflowRun({
          context,
          repositories,
          audit,
          runId: runInput.runId,
        });
        return { run: mapWorkflowFromDomain(result.workflow) };
      },

      async cancel(runInput) {
        assertSessionToken(context, runInput.token);
        assertRunInScope(db, context, runInput.runId);
        await repositories.updateWorkflowInstanceStatus(
          runInput.runId,
          'cancelled',
        );
        return { run: mapWorkflow(mustGetRun(db, runInput.runId)) };
      },

      async clean(runInput) {
        assertSessionToken(context, runInput.token);
        assertRunInScope(db, context, runInput.runId);
        const runDir = join(context.dataDir, 'runs', runInput.runId);
        const removedRunDir = existsSync(runDir);
        if (removedRunDir) {
          rmSync(runDir, { recursive: true, force: true });
        }
        return { removedRunDir };
      },
    },

    delivery: {
      async prepare(deliveryInput) {
        assertSessionToken(context, deliveryInput.token);
        assertRunInScope(db, context, deliveryInput.runId);
        const preparation = await createPullRequestPreparation({
          repoPath: context.projectRoot,
          repositories,
          audit,
          runId: deliveryInput.runId,
        });
        return {
          runId: deliveryInput.runId,
          branch: preparation.branch,
          baseBranch: preparation.baseBranch,
          packagePath: preparation.packagePath,
          prBodyPath: preparation.prBodyPath,
          requiresHumanApproval: preparation.requiresHumanApproval,
        };
      },

      async createPr(deliveryInput) {
        assertSessionToken(context, deliveryInput.token);
        assertRunInScope(db, context, deliveryInput.runId);
        const preparation = await createPullRequestPreparation({
          repoPath: context.projectRoot,
          repositories,
          audit,
          runId: deliveryInput.runId,
        });
        const result = await createScmDelivery({
          repoPath: context.projectRoot,
          env: context.env,
          repositories,
          audit,
          outputDir: join(
            context.dataDir,
            'runs',
            deliveryInput.runId,
            'delivery',
            'scm',
          ),
        }).createPr({
          runId: deliveryInput.runId,
          title: preparation.title,
          body: readFileSync(preparation.prBodyPath, 'utf8'),
          bodyPath: preparation.prBodyPath,
          branch: preparation.branch,
          baseBranch: preparation.baseBranch,
          dryRun: false,
          humanApproved: Boolean(deliveryInput.approveHuman),
          approvedBy: 'web',
        });
        const delivery = await repositories.getDeliveryPullRequest(
          deliveryInput.runId,
        );
        return {
          runId: deliveryInput.runId,
          deliveryStatus: delivery?.status ?? 'unknown',
          requiresHumanApproval: result.requiresHumanApproval,
          prUrl: result.prUrl ?? delivery?.prUrl ?? null,
          failureStage: delivery?.failureStage ?? null,
          lastError: delivery?.lastError ?? null,
          branch: delivery?.branch ?? null,
          baseBranch: delivery?.baseBranch ?? null,
        };
      },
    },

    artifact: {
      async list(artifactInput) {
        assertRunInScope(db, context, artifactInput.runId);
        return {
          artifacts: listArtifacts(db, artifactInput.runId).map(mapArtifact),
        };
      },
    },

    gate: {
      async list(gateInput) {
        assertRunInScope(db, context, gateInput.runId);
        const pendingDecisions = listHumanDecisions(db, gateInput.runId).filter(
          (decision) => decision.status === 'pending',
        );
        const summaries = await Promise.all(
          pendingDecisions.map((decision) =>
            createHumanApprovalSummary({
              repoPath: context.projectRoot,
              repositories,
              audit,
              runId: gateInput.runId,
              decisionId: decision.id,
              maxContentChars: 1_200,
              commandDisplay: 'explicit',
            }),
          ),
        );
        return {
          gates: listGates(db, gateInput.runId).map(mapGate),
          pendingDecisions: pendingDecisions.map((decision, index) =>
            mapHumanDecision(db, decision, summaries[index] ?? null),
          ),
        };
      },

      async approve(decisionInput) {
        return updateDecision({
          db,
          repositories,
          audit,
          context,
          input: decisionInput,
          status: 'approved',
          gateStatus: 'passed',
          gateFailureClassification: null,
        });
      },

      async reject(decisionInput) {
        return updateDecision({
          db,
          repositories,
          audit,
          context,
          input: decisionInput,
          status: 'rejected',
          gateStatus: 'failed',
          gateFailureClassification: 'human-rejected',
        });
      },
    },

    audit: {
      async list(auditInput) {
        assertRunInScope(db, context, auditInput.runId);
        const events = await repositories.listAuditEvents(auditInput.runId);
        const nodeById = new Map(
          listNodes(db, auditInput.runId).map((node) => [node.id, node]),
        );
        return {
          verification: await audit.verify(auditInput.runId),
          events: events
            .map((event) => mapAuditEvent(event, nodeById))
            .filter((event) => matchesAuditFilters(event, auditInput)),
        };
      },
    },

    review: {
      async get(reviewInput) {
        assertRunInScope(db, context, reviewInput.runId);
        return createWorkReviewSurface({
          repoPath: context.projectRoot,
          repositories,
          audit,
          runId: reviewInput.runId,
          maxContentChars: reviewInput.maxContentChars,
          commandDisplay: 'explicit',
        });
      },
    },

    role: {
      async list() {
        return { roles: listRoles(context) };
      },
    },

    workflow: {
      async list() {
        return { workflows: listWorkflows(context) };
      },
    },

    async close() {
      db.close();
    },
  };

  return caller;
}

export async function dispatchApiCall(
  caller: ApiCaller,
  path: string,
  input: unknown,
): Promise<unknown> {
  const [namespace, procedure] = path.split('.');
  const router = caller[namespace as keyof ApiCaller] as
    | Record<string, (input?: unknown) => Promise<unknown>>
    | undefined;
  const handler = router?.[procedure ?? ''];
  if (!handler) {
    throw new ApiError('NOT_FOUND', `Unknown API procedure: ${path}`);
  }
  return handler(input);
}

function listScopedProjects(
  db: TekonDatabase,
  context: WebProjectContext,
): ProjectRow[] {
  return (
    db
      .prepare('select * from projects order by created_at, id')
      .all() as ProjectRow[]
  ).filter((project) => resolve(project.repo_path) === context.projectRoot);
}

function firstProjectOrFallback(
  db: TekonDatabase,
  context: WebProjectContext,
): ProjectRow {
  return (
    listScopedProjects(db, context)[0] ?? {
      id: 'local',
      name: basenameForProject(context.projectRoot),
      repo_path: context.projectRoot,
      created_at: new Date(0).toISOString(),
    }
  );
}

function latestScopedRun(
  db: TekonDatabase,
  context: WebProjectContext,
): { project: ProjectRow; run: WorkflowRow } | null {
  const runs = listScopedProjects(db, context).flatMap((project) =>
    listRunsForProject(db, project.id).map((run) => ({ project, run })),
  );
  return (
    runs.sort((left, right) => {
      const byUpdated =
        Date.parse(right.run.updated_at) - Date.parse(left.run.updated_at);
      return byUpdated === 0
        ? right.run.id.localeCompare(left.run.id)
        : byUpdated;
    })[0] ?? null
  );
}

function listRunsForScopedProjects(
  db: TekonDatabase,
  context: WebProjectContext,
): WorkflowRow[] {
  return listScopedProjects(db, context)
    .flatMap((project) => listRunsForProject(db, project.id))
    .sort((left, right) => {
      const byUpdated =
        Date.parse(right.updated_at) - Date.parse(left.updated_at);
      return byUpdated === 0 ? right.id.localeCompare(left.id) : byUpdated;
    });
}

function scopedProjectById(
  db: TekonDatabase,
  context: WebProjectContext,
  projectId: string,
): ProjectRow {
  const project = listScopedProjects(db, context).find(
    (candidate) => candidate.id === projectId,
  );
  if (!project) {
    throw new ApiError('NOT_FOUND', `Project not found: ${projectId}`);
  }
  return project;
}

function listRunsForProject(
  db: TekonDatabase,
  projectId: string,
): WorkflowRow[] {
  return db
    .prepare(
      `select * from workflow_instances
       where project_id = ?
       order by updated_at desc, id`,
    )
    .all(projectId) as WorkflowRow[];
}

function latestRunForProject(
  db: TekonDatabase,
  projectId: string,
): WorkflowRow | null {
  return listRunsForProject(db, projectId)[0] ?? null;
}

function mustGetRun(db: TekonDatabase, runId: string): WorkflowRow {
  const run = db
    .prepare('select * from workflow_instances where id = ?')
    .get(runId) as WorkflowRow | undefined;
  if (!run) {
    throw new ApiError('NOT_FOUND', `Run not found: ${runId}`);
  }
  return run;
}

function assertRunInScope(
  db: TekonDatabase,
  context: WebProjectContext,
  runId: string,
): void {
  const run = mustGetRun(db, runId);
  scopedProjectById(db, context, run.project_id);
}

function assertDemandShapePathInScope(
  context: WebProjectContext,
  shapePath: string,
): string {
  const resolvedPath = resolve(shapePath);
  const demandsDir = assertDemandShapeStorageInScope(context, {
    create: false,
  });
  const pathFromDemands = relative(demandsDir, resolvedPath);
  if (
    pathFromDemands.startsWith('..') ||
    pathFromDemands === '' ||
    pathFromDemands.includes('..') ||
    !pathFromDemands.endsWith('.json')
  ) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (!existsSync(demandsDir) || !existsSync(resolvedPath)) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (lstatSync(resolvedPath).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  const expectedDemandsDir = realpathSync(demandsDir);
  const realPathFromDemands = relative(
    expectedDemandsDir,
    realpathSync(resolvedPath),
  );
  if (realPathFromDemands.startsWith('..') || realPathFromDemands === '') {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  return resolvedPath;
}

function assertDemandShapeStorageInScope(
  context: WebProjectContext,
  options: { create: boolean },
): string {
  const dataDir = resolve(context.dataDir);
  const demandsDir = resolve(dataDir, 'demands');
  if (!existsSync(dataDir)) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (lstatSync(dataDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  const expectedDataDir = resolve(realpathSync(context.projectRoot), '.tekon');
  const realDataDir = realpathSync(dataDir);
  if (realDataDir !== expectedDataDir) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (existsSync(demandsDir) && lstatSync(demandsDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (options.create) {
    mkdirSync(demandsDir, { recursive: true });
  }
  if (!existsSync(demandsDir)) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (lstatSync(demandsDir).isSymbolicLink()) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  if (realpathSync(demandsDir) !== resolve(realDataDir, 'demands')) {
    throw new ApiError('BAD_REQUEST', 'Demand shape path is out of scope.');
  }
  return demandsDir;
}

function listArtifacts(db: TekonDatabase, runId: string): ArtifactRow[] {
  return db
    .prepare(
      'select * from artifacts where run_id = ? order by node_id, type, version',
    )
    .all(runId) as ArtifactRow[];
}

function listGates(db: TekonDatabase, runId: string): GateRow[] {
  return db
    .prepare(
      'select * from gate_results where run_id = ? order by created_at, id',
    )
    .all(runId) as GateRow[];
}

function getGate(db: TekonDatabase, gateId: string | null): GateRow | null {
  if (!gateId) {
    return null;
  }
  return (
    (db.prepare('select * from gate_results where id = ?').get(gateId) as
      | GateRow
      | undefined) ?? null
  );
}

function listNodes(db: TekonDatabase, runId: string): NodeRow[] {
  return db
    .prepare('select * from nodes where run_id = ? order by created_at, id')
    .all(runId) as NodeRow[];
}

function getNode(db: TekonDatabase, nodeId: string): NodeRow | null {
  return (
    (db.prepare('select * from nodes where id = ?').get(nodeId) as
      | NodeRow
      | undefined) ?? null
  );
}

function listHumanDecisions(
  db: TekonDatabase,
  runId: string,
): HumanDecisionRow[] {
  return db
    .prepare(
      'select * from human_decisions where run_id = ? order by created_at, id',
    )
    .all(runId) as HumanDecisionRow[];
}

function count(db: TekonDatabase, table: string, runId: string): number {
  const row = db
    .prepare(`select count(*) as total from ${table} where run_id = ?`)
    .get(runId) as { total: number };
  return row.total;
}

function pendingDecisionCount(db: TekonDatabase, runId: string): number {
  const row = db
    .prepare(
      `select count(*) as total from human_decisions
       where run_id = ? and status = 'pending'`,
    )
    .get(runId) as { total: number };
  return row.total;
}

async function updateDecision(input: {
  db: TekonDatabase;
  repositories: ReturnType<typeof createRepositories>;
  audit: ReturnType<typeof createAuditLogger>;
  context: WebProjectContext;
  input: DecisionInput;
  status: 'approved' | 'rejected';
  gateStatus: 'passed' | 'failed';
  gateFailureClassification: string | null;
}): Promise<{ decision: ReturnType<typeof mapHumanDecision> }> {
  assertSessionToken(input.context, input.input.token);
  assertRunInScope(input.db, input.context, input.input.runId);
  const existing = input.db
    .prepare('select * from human_decisions where id = ? and run_id = ?')
    .get(input.input.decisionId, input.input.runId) as
    | HumanDecisionRow
    | undefined;
  if (!existing) {
    throw new ApiError(
      'NOT_FOUND',
      `Decision not found: ${input.input.decisionId}`,
    );
  }
  if (existing.status !== 'pending') {
    throw new ApiError(
      'BAD_REQUEST',
      `Decision is already ${existing.status}: ${input.input.decisionId}`,
    );
  }
  if (input.status === 'approved') {
    await assertRunCanResume({
      repositories: input.repositories,
      runId: existing.run_id,
    });
  }

  const decidedAt = new Date().toISOString();
  const decision = await input.repositories.updateHumanDecision(
    input.input.decisionId,
    {
      status: input.status,
      actor: input.input.actor,
      note: input.input.note ?? null,
      decidedAt,
    },
  );
  if (!decision) {
    throw new ApiError(
      'NOT_FOUND',
      `Decision not found: ${input.input.decisionId}`,
    );
  }

  if (existing.gate_result_id) {
    await input.repositories.updateGateResultStatus(existing.gate_result_id, {
      status: input.gateStatus,
      failureClassification: input.gateFailureClassification,
    });
  }

  if (input.status === 'approved') {
    await input.repositories.transitionNode(existing.node_id, 'running');
    await input.repositories.transitionNode(existing.node_id, 'awaiting-gate');
    await input.audit.append({
      runId: existing.run_id,
      type: 'human.gate.approved',
      payload: {
        decisionId: existing.id,
        nodeId: existing.node_id,
        actor: input.input.actor,
      },
    });
    await resumeWorkflowRun({
      context: input.context,
      repositories: input.repositories,
      audit: input.audit,
      runId: existing.run_id,
    });
  } else {
    await input.repositories.transitionNode(existing.node_id, 'blocked');
    await input.repositories.updateWorkflowInstanceStatus(
      existing.run_id,
      'blocked',
      existing.node_id,
    );
    await input.audit.append({
      runId: existing.run_id,
      type: 'human.gate.rejected',
      payload: {
        decisionId: existing.id,
        nodeId: existing.node_id,
        actor: input.input.actor,
      },
    });
  }

  return { decision: mapHumanDecisionRow(input.db, decision) };
}

async function resumeWorkflowRun(input: {
  context: WebProjectContext;
  repositories: ReturnType<typeof createRepositories>;
  audit: ReturnType<typeof createAuditLogger>;
  runId: string;
}) {
  const gateway = createCommandGateway({ repositories: input.repositories });
  const runProvider = await input.repositories.getRunProviderConfig(
    input.runId,
  );
  if (!runProvider) {
    throw new ApiError(
      'BAD_REQUEST',
      `Run ${input.runId} has no provider snapshot; cannot resume safely.`,
    );
  }
  const engine = createWorkflowEngine({
    repoPath: input.context.projectRoot,
    dataDir: '.tekon',
    repositories: input.repositories,
    audit: input.audit,
    adapter: createWebAgentAdapterFromSnapshot(gateway, runProvider),
    agentProvider: runProvider.provider,
    agentConfigSummary: runProvider.configSummary,
    gateEngine: createGateEngine({
      repositories: input.repositories,
      gateway,
    }),
    worktreeManager: createWorktreeManager({
      repositories: input.repositories,
      gateway,
    }),
  });
  return engine.resumeRun(input.runId);
}

function createWebAgentRuntime(input: {
  agent: string;
  repoPath: string;
  gateway: CommandGateway;
}): {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
} {
  if (input.agent === 'mock') {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: { provider: 'mock' },
    };
  }

  if (input.agent === 'claude-code') {
    const config = defaultWebClaudeCodeConfig(input.repoPath);
    return {
      adapter: createClaudeCodeAdapter(config, input.gateway),
      provider: 'claude-code',
      configSummary: summarizeAgentConfig(config),
    };
  }

  if (input.agent === 'codex') {
    const config = defaultWebCodexConfig(input.repoPath);
    return {
      adapter: createCodexAdapter(config, input.gateway),
      provider: 'codex',
      configSummary: summarizeAgentConfig(config),
    };
  }

  throw new ApiError('BAD_REQUEST', `Unsupported agent: ${input.agent}`);
}

async function assertRunCanResume(input: {
  repositories: ReturnType<typeof createRepositories>;
  runId: string;
}) {
  const provider = await input.repositories.getRunProviderConfig(input.runId);
  if (!provider) {
    throw new ApiError(
      'BAD_REQUEST',
      `Run ${input.runId} has no provider snapshot; cannot resume safely.`,
    );
  }
  createWebAgentAdapterFromSnapshot(createCommandGateway(), provider);
}

function createWebAgentAdapterFromSnapshot(
  gateway: CommandGateway,
  provider: RunProviderConfig,
) {
  if (provider.provider === 'mock') {
    return createMockAgentAdapter();
  }
  if (provider.provider === 'claude-code') {
    const parsed = agentAdapterConfigSchema.safeParse(provider.configSummary);
    if (!parsed.success || parsed.data.provider !== 'claude-code') {
      throw new ApiError(
        'BAD_REQUEST',
        `Run ${provider.runId} has a non-replayable claude-code provider snapshot.`,
      );
    }
    return createClaudeCodeAdapter(parsed.data, gateway);
  }
  if (provider.provider === 'codex') {
    const parsed = agentAdapterConfigSchema.safeParse(provider.configSummary);
    if (!parsed.success || parsed.data.provider !== 'codex') {
      throw new ApiError(
        'BAD_REQUEST',
        `Run ${provider.runId} has a non-replayable codex provider snapshot.`,
      );
    }
    return createCodexAdapter(parsed.data, gateway);
  }
  throw new ApiError(
    'BAD_REQUEST',
    'Web resume does not support custom agent adapters yet',
  );
}

function defaultWebClaudeCodeConfig(repoPath: string): AgentAdapterConfig {
  return {
    provider: 'claude-code',
    command: 'claude',
    args: ['-p'],
    promptMode: 'stdin',
    outputFormat: 'json',
    timeoutMs: 300_000,
    permissionProfile: {
      sandbox: 'workspace-write',
      approval: 'on-request',
      filesystemScope: [repoPath],
      network: 'restricted',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
}

function defaultWebCodexConfig(repoPath: string): AgentAdapterConfig {
  return {
    provider: 'codex',
    command: 'codex',
    args: [],
    promptMode: 'stdin',
    outputFormat: 'text',
    timeoutMs: 300_000,
    permissionProfile: {
      sandbox: 'workspace-write',
      approval: 'on-request',
      filesystemScope: [repoPath],
      network: 'restricted',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
}

function summarizeAgentConfig(
  config: AgentAdapterConfig,
): Record<string, unknown> {
  return {
    provider: config.provider,
    command: config.command,
    args: config.args,
    promptMode: config.promptMode,
    outputFormat: config.outputFormat,
    timeoutMs: config.timeoutMs,
    permissionProfile: {
      sandbox: config.permissionProfile.sandbox,
      approval: config.permissionProfile.approval,
      filesystemScope: config.permissionProfile.filesystemScope,
      network: config.permissionProfile.network,
      tools: config.permissionProfile.tools,
    },
  };
}

function assertSessionToken(
  context: WebProjectContext,
  providedToken: string,
): void {
  if (!providedToken) {
    throw new ApiError('UNAUTHORIZED', 'Session token is required');
  }

  let expectedToken: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(context.sessionPath, 'utf8')) as {
      token?: unknown;
    };
    expectedToken = typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    throw new ApiError('UNAUTHORIZED', 'Web session token is not configured');
  }

  if (providedToken !== expectedToken) {
    throw new ApiError('UNAUTHORIZED', 'Invalid session token');
  }
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

function assertSafeName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(name)) {
    throw new ApiError('BAD_REQUEST', `Invalid ${label}: ${name}`);
  }
}

function listRoles(
  context: WebProjectContext,
): Array<{ id: string; name: string; systemPrompt?: string }> {
  if (!existsSync(context.rolesDir)) {
    return [];
  }

  return readdirSync(context.rolesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const systemPath = join(context.rolesDir, entry.name, 'system.md');
      return {
        id: entry.name,
        name: entry.name.toUpperCase(),
        systemPrompt: existsSync(systemPath)
          ? readFileSync(systemPath, 'utf8')
          : undefined,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function listWorkflows(
  context: WebProjectContext,
): Array<{ id: string; name: string; path: string }> {
  if (!existsSync(context.workflowsDir)) {
    return [];
  }

  return readdirSync(context.workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => {
      const path = join(context.workflowsDir, entry.name);
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

function loadProjectWorkflowIfPresent(
  context: WebProjectContext,
  name: string,
): WorkflowTemplate | null {
  for (const extension of ['.yaml', '.yml']) {
    const workflowPath = join(context.workflowsDir, `${name}${extension}`);
    if (existsSync(workflowPath)) {
      return loadWorkflowTemplateFile(workflowPath);
    }
  }
  return null;
}

function extractYamlScalar(content: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(content);
  return match?.[1]?.trim().replace(/^["']|["']$/gu, '');
}

function mapProject(project: ProjectRow) {
  return {
    id: project.id,
    name: project.name,
    repoPath: project.repo_path,
    createdAt: project.created_at,
  };
}

function mapWorkflow(run: WorkflowRow) {
  return {
    id: run.id,
    projectId: run.project_id,
    demandId: run.demand_id,
    status: run.status,
    currentNodeId: run.current_node_id,
    createdAt: run.created_at,
    updatedAt: run.updated_at,
  };
}

function mapWorkflowFromDomain(run: WorkflowInstance) {
  return {
    id: run.id,
    projectId: run.projectId,
    demandId: run.demandId,
    status: run.status,
    currentNodeId: run.currentNodeId ?? null,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}

function mapArtifact(artifact: ArtifactRow) {
  return {
    id: artifact.id,
    runId: artifact.run_id,
    nodeId: artifact.node_id,
    type: artifact.type,
    version: artifact.version,
    path: artifact.path,
    sha256: artifact.sha256,
    sizeBytes: artifact.size_bytes,
    summary: artifact.summary,
    createdAt: artifact.created_at,
  };
}

function mapGate(gate: GateRow) {
  return {
    id: gate.id,
    runId: gate.run_id,
    nodeId: gate.node_id,
    gateType: gate.gate_type,
    status: gate.status,
    outputPath: gate.output_path,
    durationMs: gate.duration_ms,
    retries: gate.retries,
    fixAttemptId: gate.fix_attempt_id,
    failureClassification: gate.failure_classification,
    createdAt: gate.created_at,
  };
}

function mapAuditEvent(
  event: {
    id: string;
    runId: string;
    type: string;
    payload: Record<string, unknown>;
    prevHash?: string | null;
    hash: string;
    createdAt: string;
  },
  nodeById: Map<string, NodeRow>,
) {
  const nodeId = stringValue(event.payload.nodeId);
  const gateId =
    stringValue(event.payload.gateResultId) ??
    stringValue(event.payload.gateId);
  const role =
    stringValue(event.payload.role) ??
    (nodeId ? (nodeById.get(nodeId)?.role ?? null) : null);
  return {
    id: event.id,
    runId: event.runId,
    type: event.type,
    payload: event.payload,
    nodeId,
    gateId,
    role,
    prevHash: event.prevHash ?? null,
    hash: event.hash,
    createdAt: event.createdAt,
  };
}

function matchesAuditFilters(
  event: ReturnType<typeof mapAuditEvent>,
  filters: { nodeId?: string; gateId?: string; role?: string },
) {
  if (filters.nodeId && event.nodeId !== filters.nodeId) {
    return false;
  }
  if (filters.gateId && event.gateId !== filters.gateId) {
    return false;
  }
  if (filters.role && event.role !== filters.role) {
    return false;
  }
  return true;
}

function mapHumanDecision(
  db: TekonDatabase,
  decision: HumanDecisionRow,
  approvalSummary: Awaited<
    ReturnType<typeof createHumanApprovalSummary>
  > | null = null,
) {
  const gate = getGate(db, decision.gate_result_id);
  const node = getNode(db, decision.node_id);
  return {
    id: decision.id,
    runId: decision.run_id,
    nodeId: decision.node_id,
    gateResultId: decision.gate_result_id,
    status: decision.status,
    actor: decision.actor,
    note: decision.note,
    createdAt: decision.created_at,
    decidedAt: decision.decided_at,
    context: {
      request: decision.note ?? 'No request context recorded.',
      exactCommand: extractExactCommand(decision.note),
      riskLabel: deriveRiskLabel(decision.note, gate),
      nodeRole: node?.role ?? null,
      approvalSummary,
      approvalEvaluation: approvalSummary
        ? evaluateHumanApprovalSummary(approvalSummary)
        : null,
      gate: gate
        ? {
            id: gate.id,
            type: gate.gate_type,
            status: gate.status,
            nodeId: gate.node_id,
            outputPath: gate.output_path,
            failureClassification: gate.failure_classification,
          }
        : null,
    },
  };
}

function mapHumanDecisionRow(
  db: TekonDatabase,
  decision: {
    id: string;
    runId: string;
    nodeId: string;
    gateResultId?: string | null;
    status: string;
    actor?: string | null;
    note?: string | null;
    createdAt: string;
    decidedAt?: string | null;
  },
) {
  const row = {
    id: decision.id,
    runId: decision.runId,
    nodeId: decision.nodeId,
    gateResultId: decision.gateResultId ?? null,
    status: decision.status,
    actor: decision.actor ?? null,
    note: decision.note ?? null,
    createdAt: decision.createdAt,
    decidedAt: decision.decidedAt ?? null,
  };
  return mapHumanDecision(db, {
    id: row.id,
    run_id: row.runId,
    node_id: row.nodeId,
    gate_result_id: row.gateResultId,
    status: row.status,
    actor: row.actor,
    note: row.note,
    created_at: row.createdAt,
    decided_at: row.decidedAt,
  });
}

function extractExactCommand(note?: string | null): string {
  if (!note) {
    return 'not recorded';
  }
  const commandLine = /(?:exactCommand|command):\s*([^\n]+)/iu.exec(note);
  if (commandLine?.[1]) {
    return commandLine[1].trim();
  }
  const approvalLine = /Command requires approval:\s*([^\n]+)/iu.exec(note);
  if (approvalLine?.[1]) {
    return approvalLine[1].trim();
  }
  return 'not recorded';
}

function deriveRiskLabel(note: string | null, gate: GateRow | null): string {
  const riskLine = /risk:\s*([a-z-]+)/iu.exec(note ?? '');
  if (riskLine?.[1]) {
    return riskLine[1].toLowerCase();
  }
  if (gate?.gate_type === 'human') {
    return 'human-control';
  }
  if (gate?.failure_classification) {
    return gate.failure_classification;
  }
  return 'normal';
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function basenameForProject(repoPath: string): string {
  return repoPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'tekon';
}
