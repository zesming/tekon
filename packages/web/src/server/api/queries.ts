import { resolve } from 'node:path';

import { type TekonDatabase } from '@tekon/core';

import type { WebProjectContext } from '../project-context.js';
import { ApiError } from './errors.js';
import type {
  ArtifactRow,
  GateRow,
  HumanDecisionRow,
  NodeRow,
  ProjectRow,
  WorkflowRow,
} from './rows.js';

export type { TekonDatabase };

export function listScopedProjects(
  db: TekonDatabase,
  context: WebProjectContext,
): ProjectRow[] {
  return (
    db
      .prepare('select * from projects order by created_at, id')
      .all() as ProjectRow[]
  ).filter((project) => resolve(project.repo_path) === context.projectRoot);
}

export function firstProjectOrFallback(
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

export function latestScopedRun(
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

export function listRunsForScopedProjects(
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

export function scopedProjectById(
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

export function listRunsForProject(
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

export function mustGetRun(db: TekonDatabase, runId: string): WorkflowRow {
  const run = db
    .prepare('select * from workflow_instances where id = ?')
    .get(runId) as WorkflowRow | undefined;
  if (!run) {
    throw new ApiError('NOT_FOUND', `Run not found: ${runId}`);
  }
  return run;
}

export function assertRunInScope(
  db: TekonDatabase,
  context: WebProjectContext,
  runId: string,
): void {
  const run = mustGetRun(db, runId);
  scopedProjectById(db, context, run.project_id);
}

export function listArtifacts(db: TekonDatabase, runId: string): ArtifactRow[] {
  return db
    .prepare(
      'select * from artifacts where run_id = ? order by node_id, type, version',
    )
    .all(runId) as ArtifactRow[];
}

export function listGates(db: TekonDatabase, runId: string): GateRow[] {
  return db
    .prepare(
      'select * from gate_results where run_id = ? order by created_at, id',
    )
    .all(runId) as GateRow[];
}

export function getGate(
  db: TekonDatabase,
  gateId: string | null,
): GateRow | null {
  if (!gateId) {
    return null;
  }
  return (
    (db.prepare('select * from gate_results where id = ?').get(gateId) as
      | GateRow
      | undefined) ?? null
  );
}

export function listNodes(db: TekonDatabase, runId: string): NodeRow[] {
  return db
    .prepare('select * from nodes where run_id = ? order by created_at, id')
    .all(runId) as NodeRow[];
}

export function getNode(db: TekonDatabase, nodeId: string): NodeRow | null {
  return (
    (db.prepare('select * from nodes where id = ?').get(nodeId) as
      | NodeRow
      | undefined) ?? null
  );
}

export function listHumanDecisions(
  db: TekonDatabase,
  runId: string,
): HumanDecisionRow[] {
  return db
    .prepare(
      'select * from human_decisions where run_id = ? order by created_at, id',
    )
    .all(runId) as HumanDecisionRow[];
}

export function count(db: TekonDatabase, table: string, runId: string): number {
  const row = db
    .prepare(`select count(*) as total from ${table} where run_id = ?`)
    .get(runId) as { total: number };
  return row.total;
}

export function pendingDecisionCount(
  db: TekonDatabase,
  runId: string,
): number {
  const row = db
    .prepare(
      `select count(*) as total from human_decisions
       where run_id = ? and status = 'pending'`,
    )
    .get(runId) as { total: number };
  return row.total;
}

function basenameForProject(repoPath: string): string {
  return repoPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'tekon';
}
