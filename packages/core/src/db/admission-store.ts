import { createHash, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { TekonDatabase } from "./connection.js";
import type { WriteQueue } from "./write-queue.js";
import { canonicalJson } from "../workflow/run-plan.js";
import { appendAuditEventTxn } from "../audit/logger.js";
import { sessionEventSchema, type SessionEvent } from "../types/session-contract.js";
import { workflowInstanceSchema, type WorkflowInstance } from "../types/domain.js";

export function isValidRequestId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{8,128}$/.test(id);
}

export interface RunAdmissionEnvelope {
  // Callers own the explicit intent fields; hashing must never whitelist them away.
  [key: string]: unknown;
  version: number;
  scope: string; // canonical physical repo root
  demandTextOrRef: string;
  mode: "workflow" | "goal";
  templateName?: string;
  profile?: string;
  agent?: string;
  allowDirtyBase?: boolean;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  progressHeartbeatMs?: number;
  acknowledgeUnrestrictedNetwork?: boolean;
  planDigest?: string;
  inlinedWorkflowSpecDigest?: string;
  inlinedCanonicalPlanDigest?: string;
}


export function buildRunAdmissionEnvelope(input: {
  [key: string]: unknown;
  scope: string;
  demandTextOrRef: string;
  mode?: "workflow" | "goal";
  templateName?: string;
  profile?: string;
  agent?: string;
  allowDirtyBase?: boolean;
  timeoutMs?: number;
  noProgressTimeoutMs?: number;
  progressHeartbeatMs?: number;
  acknowledgeUnrestrictedNetwork?: boolean;
  planDigest?: string;
}): RunAdmissionEnvelope {
  const mode = input.mode ?? "workflow";
  return {
    ...input,
    version: 1,
    scope: input.scope,
    demandTextOrRef: input.demandTextOrRef.trim(),
    mode,
    templateName: mode === "goal" ? "goal" : (input.templateName?.trim() || "standard-delivery"),
    profile: input.profile ?? "human-web",
    agent: input.agent ?? "codex",
    allowDirtyBase: Boolean(input.allowDirtyBase),
    acknowledgeUnrestrictedNetwork: Boolean(input.acknowledgeUnrestrictedNetwork),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.noProgressTimeoutMs !== undefined ? { noProgressTimeoutMs: input.noProgressTimeoutMs } : {}),
    ...(input.progressHeartbeatMs !== undefined ? { progressHeartbeatMs: input.progressHeartbeatMs } : {}),
    ...(input.planDigest !== undefined && input.planDigest !== "" ? { planDigest: input.planDigest } : {}),
  };
}

export function hashAdmissionEnvelope(envelope: RunAdmissionEnvelope): string {
  assertJsonIntent(envelope);
  const canonical = canonicalJson(envelope);
  return createHash("sha256").update(canonical).digest("hex");
}

function assertJsonIntent(value: unknown, ancestors = new Set<object>(), inArray = false): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  // Optional object properties follow canonical JSON's undefined omission rule.
  if (value === undefined && !inArray) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (typeof value !== 'object' || value === null || ancestors.has(value)) {
    throw new Error('INVALID_ADMISSION_ENVELOPE');
  }
  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
    throw new Error('INVALID_ADMISSION_ENVELOPE');
  }
  if (Object.getOwnPropertySymbols(value).length > 0) throw new Error('INVALID_ADMISSION_ENVELOPE');
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (isArray) {
    const length = descriptors.length.value as number;
    // Only a dense set of own data indices plus Array's length is JSON input.
    // Inspect descriptors before reading elements so accessors never execute.
    if (Object.keys(descriptors).length !== length + 1) throw new Error('INVALID_ADMISSION_ENVELOPE');
    for (let index = 0; index < length; index++) {
      const descriptor = descriptors[index];
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) {
        throw new Error('INVALID_ADMISSION_ENVELOPE');
      }
      assertJsonIntent(descriptor.value, ancestors, true);
    }
  } else {
    for (const descriptor of Object.values(descriptors)) {
      if (descriptor.get || descriptor.set) throw new Error('INVALID_ADMISSION_ENVELOPE');
      assertJsonIntent(descriptor.value, ancestors);
    }
  }
  ancestors.delete(value);
}

export interface RunAdmissionRow {
  requestId: string;
  envelopeVersion: number;
  envelopeHash: string;
  runId: string;
  sessionId: string | null;
  jobId: string | null;
  dataDir: string;
  filesState: "pending" | "ready" | "recovery_required";
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PreparedAdmissionData {
  requestId: string;
  envelopeVersion: number;
  envelopeHash: string;
  runId: string;
  projectId: string;
  projectName: string;
  repoPath: string;
  dataDir: string;
  demandId: string;
  demandTitle: string;
  demandBody: string;
  demandSource?: string;
  workflowKind: "workflow" | "goal";
  allowDirtyBase: boolean;
  planSnapshot: string;
  planDigest: string;
  providerSnapshot?: {
    provider: string;
    configSummary: Record<string, unknown>;
  };
  phases: Array<{
    id: string;
    name: string;
    order: number;
    nodes: Array<{
      id: string;
      role: string;
      order: number;
      inputs: unknown[];
      outputs: unknown[];
      gates: unknown[];
      dependencies: string[];
    }>;
  }>;
  admissionAudits?: Array<{
    type: string;
    payload: Record<string, unknown>;
  }>;
  sessionData?: {
    sessionId: string;
    workspaceRoot: string;
    profile: string;
    jobId: string;
    jobKind: "workflow-run" | "goal-run";
  };
  templateId?: string;
}

export interface AdmissionOutcome {
  outcome: 'admitted' | 'already_admitted';
  runId: string;
  sessionId?: string;
  jobId?: string;
  requestId: string;
  filesState: RunAdmissionRow['filesState'];
  admission: RunAdmissionRow;
  workflow: WorkflowInstance;
  /** Returned only to the transaction winner for post-commit publication. */
  openingEvents: SessionEvent[];
}

export interface AdmissionStore {
  admitRun(data: PreparedAdmissionData): Promise<AdmissionOutcome>;
  getAdmission(requestId: string): Promise<RunAdmissionRow | null>;
  getAdmissionByRunId(runId: string): Promise<RunAdmissionRow | null>;
  recoverAdmissionFiles(requestId: string): Promise<RunAdmissionRow>;
  scanAndRecoverAdmissions(): Promise<number>;
}

export function createAdmissionStore(options: {
  db: TekonDatabase;
  writeQueue: WriteQueue;
}): AdmissionStore {
  const { db, writeQueue } = options;
  const now = () => new Date().toISOString();

  function mapRow(row: any): RunAdmissionRow {
    return {
      requestId: row.request_id,
      envelopeVersion: row.envelope_version,
      envelopeHash: row.envelope_hash,
      runId: row.run_id,
      sessionId: row.session_id,
      jobId: row.job_id,
      dataDir: row.data_dir,
      filesState: row.files_state,
      lastError: row.last_error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  async function getAdmission(requestId: string): Promise<RunAdmissionRow | null> {
    const row = db
      .prepare("select * from run_admissions where request_id = ?")
      .get(requestId) as any;
    return row ? mapRow(row) : null;
  }

  async function getAdmissionByRunId(runId: string): Promise<RunAdmissionRow | null> {
    const row = db
      .prepare("select * from run_admissions where run_id = ?")
      .get(runId) as any;
    return row ? mapRow(row) : null;
  }

  async function recoverAdmissionFiles(requestId: string): Promise<RunAdmissionRow> {
    return writeQueue.enqueue(() => {
      const row = db
        .prepare("select ra.*, p.repo_path from run_admissions ra join workflow_instances wi on wi.id = ra.run_id join projects p on p.id = wi.project_id where ra.request_id = ?")
        .get(requestId) as any;
      if (!row) {
        throw new Error('ADMISSION_NOT_FOUND');
      }
      if (row.files_state === 'ready') return mapRow(row);
      let filesState: RunAdmissionRow['filesState'] = 'ready';
      try {
        prepareRunDirectory(row.repo_path, row.data_dir, row.run_id);
      } catch {
        filesState = 'recovery_required';
      }
      // A slower failed recovery must not overwrite another process's ready state.
      // DB failures propagate as unknown admission state; they are not filesystem errors.
      db.prepare(
        "update run_admissions set files_state = ?, last_error = ?, updated_at = ? where request_id = ? and files_state != 'ready'",
      ).run(filesState, filesState === 'ready' ? null : 'ADMISSION_FILES_UNAVAILABLE', now(), requestId);
      return mapRow(db.prepare('select * from run_admissions where request_id = ?').get(requestId));
    });
  }

  async function scanAndRecoverAdmissions(): Promise<number> {
    const pending = db
      .prepare("select request_id from run_admissions where files_state in ('pending', 'recovery_required')")
      .all() as Array<{ request_id: string }>;
    let recoveredCount = 0;
    for (const item of pending) {
      const state = await recoverAdmissionFiles(item.request_id);
      if (state.filesState === "ready") {
        recoveredCount++;
      }
    }
    return recoveredCount;
  }

  async function admitRun(data: PreparedAdmissionData): Promise<AdmissionOutcome> {
    if (!isValidRequestId(data.requestId)) {
      throw new Error(
        "INVALID_REQUEST_ID: requestId " + data.requestId + " must be 8-128 ASCII alphanumeric, underscore, or hyphen characters"
      );
    }

    const result = await writeQueue.enqueue(() => {
      const txn = db.transaction(() => {
        const existing = db
          .prepare("select * from run_admissions where request_id = ?")
          .get(data.requestId) as any;

        if (existing) {
          if (existing.envelope_hash !== data.envelopeHash) {
            throw new Error(
              "REQUEST_ID_CONFLICT: request ID " + data.requestId + " already used for a different submission intent"
            );
          }
          return {
            outcome: "already_admitted" as const,
            admission: mapRow(existing),
            openingEvents: [] as SessionEvent[],
          };
        }

        validateDataDir(data.dataDir);
        validateRunId(data.runId);
        // Persist the physical root once; recovery must not adopt a retargeted alias.
        const canonicalRepoPath = realpathSync(data.repoPath);
        if (data.sessionData && !data.providerSnapshot) throw new Error('PROVIDER_SNAPSHOT_REQUIRED');
        const openingEvents: SessionEvent[] = [];

        const createdAt = now();

        // 1. Demands
        db.prepare(
          "insert into demands (id, title, body, source, created_at) values (?, ?, ?, ?, ?)"
        ).run(
          data.demandId,
          data.demandTitle,
          data.demandBody,
          data.demandSource ?? null,
          createdAt
        );

        // 2. Projects (insert or ignore to support same project)
        db.prepare(
          "insert or ignore into projects (id, name, repo_path, created_at) values (?, ?, ?, ?)"
        ).run(data.projectId, data.projectName, canonicalRepoPath, createdAt);

        // 3. Workflow instance
        db.prepare(
          "insert into workflow_instances (" +
          " id, project_id, demand_id, status, kind, allow_dirty_base, plan_snapshot, plan_digest, created_at, updated_at" +
          ") values (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?)"
        ).run(
          data.runId,
          data.projectId,
          data.demandId,
          data.workflowKind,
          data.allowDirtyBase ? 1 : 0,
          data.planSnapshot,
          data.planDigest,
          createdAt,
          createdAt
        );

        // 4. Provider snapshot
        if (data.providerSnapshot) {
          db.prepare(
            "insert into run_provider_configs (run_id, provider, config_summary, created_at) values (?, ?, ?, ?)" +
            " on conflict(run_id) do update set provider = excluded.provider, config_summary = excluded.config_summary, created_at = excluded.created_at"
          ).run(
            data.runId,
            data.providerSnapshot.provider,
            JSON.stringify(data.providerSnapshot.configSummary),
            createdAt
          );
        }

        // 5. Phases and nodes
        for (const phase of data.phases) {
          db.prepare(
            "insert into phases (id, run_id, name, status, phase_order, created_at, updated_at) values (?, ?, ?, 'pending', ?, ?, ?)"
          ).run(phase.id, data.runId, phase.name, phase.order, createdAt, createdAt);

          for (const node of phase.nodes) {
            db.prepare(
              "insert into nodes (id, run_id, phase_id, role, status, inputs, outputs, gates, dependencies, node_order, created_at, updated_at) values (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)"
            ).run(
              node.id,
              data.runId,
              phase.id,
              node.role,
              JSON.stringify(node.inputs),
              JSON.stringify(node.outputs),
              JSON.stringify(node.gates),
              JSON.stringify(node.dependencies),
              node.order,
              createdAt,
              createdAt
            );
          }
        }

        // 6. Audit run.started and admissionAudits
        appendAuditEventTxn(db, {
          runId: data.runId,
          type: "run.started",
          payload: {
            templateId: data.templateId ?? (data.workflowKind === "goal" ? "goal" : "standard-delivery"),
            mode: data.demandSource ?? "template",
            kind: data.workflowKind,
          },
          createdAt,
        });

        if (data.admissionAudits) {
          for (const audit of data.admissionAudits) {
            appendAuditEventTxn(db, {
              runId: data.runId,
              type: audit.type,
              payload: audit.payload,
              createdAt,
            });
          }
        }

        // 7. Session Data (if web / session service)
        let sessionId: string | null = null;
        let jobId: string | null = null;
        if (data.sessionData) {
          sessionId = data.sessionData.sessionId;
          jobId = data.sessionData.jobId;

          const existingWs = db
            .prepare("select id from workspaces where root = ? limit 1")
            .get(data.sessionData.workspaceRoot) as any;
          let wsId = existingWs?.id;
          if (!wsId) {
            wsId = "ws_" + randomUUID();
            db.prepare(
              "insert into workspaces (id, root, created_at) values (?, ?, ?)"
            ).run(wsId, data.sessionData.workspaceRoot, createdAt);
          }

          db.prepare(
            "insert into sessions (id, workspace_id, title, profile, status, run_id, created_at, updated_at) values (?, ?, ?, ?, 'active', ?, ?, ?)"
          ).run(
            sessionId,
            wsId,
            data.demandTitle,
            data.sessionData.profile,
            data.runId,
            createdAt,
            createdAt
          );

          const ev1 = sessionEventSchema.parse({
            sessionId,
            seq: 1,
            type: "session/created",
            version: 1,
            timestamp: createdAt,
            payload: { runId: data.runId, profile: data.sessionData.profile },
            visibility: "ui-only",
            modelVisible: false,
            sourceEventSeqs: [],
          });
          const ev2 = sessionEventSchema.parse({
            sessionId,
            seq: 2,
            type: "workflow/started",
            version: 1,
            timestamp: createdAt,
            payload: {
              runId: data.runId,
              templateId: data.templateId ?? (data.workflowKind === "goal" ? "goal" : "standard-delivery"),
              mode: data.demandSource ?? "template",
              kind: data.workflowKind,
            },
            visibility: "ui-only",
            modelVisible: false,
            sourceEventSeqs: [],
          });
          const ev3 = sessionEventSchema.parse({
            sessionId,
            seq: 3,
            type: "user/message",
            version: 1,
            timestamp: createdAt,
            payload: { text: data.demandBody },
            visibility: "ui-only",
            modelVisible: true,
            sourceEventSeqs: [],
          });

          for (const ev of [ev1, ev2, ev3]) {
            db.prepare(
              "insert into session_events (session_id, seq, type, version, timestamp, payload, visibility, model_visible, source_event_seqs) values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
            ).run(
              ev.sessionId,
              ev.seq,
              ev.type,
              ev.version,
              ev.timestamp,
              JSON.stringify(ev.payload),
              ev.visibility,
              ev.modelVisible ? 1 : 0,
              JSON.stringify(ev.sourceEventSeqs)
            );
          }
          openingEvents.push(ev1, ev2, ev3);

          db.prepare(
            "insert into jobs (id, session_id, kind, status, abort_state, payload, created_at, updated_at) values (?, ?, ?, 'queued', 'none', '{}', ?, ?)"
          ).run(jobId, sessionId, data.sessionData.jobKind, createdAt, createdAt);
        }

        db.prepare(
          "insert into run_admissions (request_id, envelope_version, envelope_hash, run_id, session_id, job_id, data_dir, files_state, last_error, created_at, updated_at) values (?, ?, ?, ?, ?, ?, ?, 'pending', null, ?, ?)"
        ).run(
          data.requestId,
          data.envelopeVersion,
          data.envelopeHash,
          data.runId,
          sessionId,
          jobId,
          data.dataDir,
          createdAt,
          createdAt
        );

        const admissionRow = db
          .prepare("select * from run_admissions where request_id = ?")
          .get(data.requestId) as any;

        return {
          outcome: "admitted" as const,
          admission: mapRow(admissionRow),
          openingEvents,
        };
      });

      return txn.immediate();
    });

    const admission = await recoverAdmissionFiles(result.admission.requestId);
    const workflowRow = db.prepare('select * from workflow_instances where id = ?').get(admission.runId) as any;
    const workflow = workflowInstanceSchema.parse({
      id: workflowRow.id, projectId: workflowRow.project_id, demandId: workflowRow.demand_id,
      status: workflowRow.status, kind: workflowRow.kind, allowDirtyBase: workflowRow.allow_dirty_base === 1,
      planSnapshot: workflowRow.plan_snapshot, planDigest: workflowRow.plan_digest,
      currentNodeId: workflowRow.current_node_id, createdAt: workflowRow.created_at, updatedAt: workflowRow.updated_at,
    });
    return {
      outcome: result.outcome,
      runId: admission.runId,
      sessionId: admission.sessionId ?? undefined,
      jobId: admission.jobId ?? undefined,
      requestId: admission.requestId,
      filesState: admission.filesState,
      admission,
      workflow,
      openingEvents: result.openingEvents,
    };
  }

  return {
    admitRun,
    getAdmission,
    getAdmissionByRunId,
    recoverAdmissionFiles,
    scanAndRecoverAdmissions,
  };
}

function validateDataDir(dataDir: string): void {
  if (!dataDir || isAbsolute(dataDir) || dataDir.includes('\\') || dataDir.includes('\0') ||
      dataDir.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new Error('INVALID_DATA_DIR');
  }
}

function validateRunId(runId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(runId)) throw new Error('INVALID_RUN_ID');
}

/** Check each ancestor before any descendant write; do not follow directory links. */
function prepareRunDirectory(repoPath: string, dataDir: string, runId: string): void {
  validateDataDir(dataDir);
  validateRunId(runId);
  const realRepo = realpathSync(repoPath);
  if (!isAbsolute(repoPath) || realRepo !== repoPath) {
    throw new Error('ADMISSION_FILES_UNAVAILABLE');
  }
  let current = realRepo;
  for (const component of [...dataDir.split('/'), 'runs', runId]) {
    current = join(current, component);
    let stat;
    try {
      stat = lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      try { mkdirSync(current); } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError;
      }
      stat = lstatSync(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('ADMISSION_FILES_UNAVAILABLE');
    const rel = relative(realRepo, realpathSync(current));
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error('ADMISSION_FILES_UNAVAILABLE');
    }
  }
}
