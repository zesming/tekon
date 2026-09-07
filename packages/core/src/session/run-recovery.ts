import { appendAuditEventTxn } from '../audit/logger.js';
import type { TekonDatabase } from '../db/connection.js';
import type { WorkflowStatus } from '../types/domain.js';
import { jobExitEvidenceSchema, sessionEventSchema, type SessionEvent, type ResumeConfirmation } from '../types/session-contract.js';

export const EXECUTION_KINDS_SQL = "('workflow-run','workflow-resume','goal-run')";
export const ACTIVE_JOBS_SQL = "('queued','running','paused','cancelling')";

export interface RunRecovery {
  runStatus: WorkflowStatus | null;
  cancelRecovery: null | {
    needsControlRetry: boolean;
    needsObservationRepair: boolean;
    jobId: string | null;
    exitStatus: 'confirmed' | 'unconfirmed';
  };
  resumeRecovery: null | { previousJobId: string | null; requiresConfirmation: boolean };
}

export interface ExecutionJobRow {
  id: string;
  status: string;
  created_at: string;
  exit_evidence: string | null;
}

export function latestExecutionJob(db: TekonDatabase, runId: string): ExecutionJobRow | undefined {
  return db.prepare(`select j.* from jobs j join sessions s on s.id=j.session_id
    where s.run_id=? and j.kind in ${EXECUTION_KINDS_SQL}
    order by j.created_at desc,j.id desc limit 1`).get(runId) as ExecutionJobRow | undefined;
}

export function hasExitEvidence(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try { return jobExitEvidenceSchema.safeParse(JSON.parse(raw)).success; } catch { return false; }
}

/** One synchronous SQLite read snapshot; query failures deliberately propagate. */
export function readRunRecovery(db: TekonDatabase, runId: string): RunRecovery {
  return db.transaction((): RunRecovery => {
    const run = db.prepare('select status from workflow_instances where id=?').get(runId) as { status: WorkflowStatus } | undefined;
    const latest = latestExecutionJob(db, runId);
    const active = db.prepare(`select j.id from jobs j join sessions s on s.id=j.session_id
      where s.run_id=? and j.kind in ${EXECUTION_KINDS_SQL} and j.status in ${ACTIVE_JOBS_SQL}
      order by j.created_at desc,j.id desc limit 1`).get(runId) as { id: string } | undefined;
    const session = db.prepare('select id,status from sessions where run_id=? order by created_at,rowid limit 1')
      .get(runId) as { id: string; status: string } | undefined;
    const eventCount = session ? (db.prepare(`select count(distinct type) as n from session_events
      where session_id=? and type in ('agent/cancel-requested','agent/cancelled')`)
      .get(session.id) as { n: number }).n : 2;
    const resumable = run && !['passed','failed','cancelled'].includes(run.status);
    return {
      runStatus: run?.status ?? null,
      cancelRecovery: run?.status === 'cancelled' ? {
        needsControlRetry: Boolean(active),
        needsObservationRepair: Boolean(session && (session.status !== 'cancelled' || eventCount !== 2)),
        jobId: active?.id ?? latest?.id ?? null,
        exitStatus: !active && latest && hasExitEvidence(latest.exit_evidence) ? 'confirmed' : 'unconfirmed',
      } : null,
      resumeRecovery: resumable && !active ? {
        previousJobId: latest?.id ?? null,
        requiresConfirmation: latest ? !hasExitEvidence(latest.exit_evidence) : run.status === 'interrupted',
      } : null,
    };
  })();
}

/** Caller holds BEGIN IMMEDIATE. Returns only newly committed lifecycle events. */
export function reconcileCancelledRunTxn(db: TekonDatabase, runId: string): { sessionId?: string; events: SessionEvent[] } {
  if (!db.inTransaction) throw new Error('CANCEL_OBSERVATION_TRANSACTION_REQUIRED');
  const session = db.prepare(`select s.id from sessions s join workflow_instances w on w.id=s.run_id
    where s.run_id=? and w.status='cancelled' order by s.created_at,s.rowid limit 1`).get(runId) as { id: string } | undefined;
  if (!session) return { events: [] };
  const events: SessionEvent[] = [];
  for (const type of ['agent/cancel-requested','agent/cancelled']) {
    if (db.prepare('select 1 from session_events where session_id=? and type=? limit 1').get(session.id, type)) continue;
    const { seq } = db.prepare('select coalesce(max(seq),0)+1 as seq from session_events where session_id=?')
      .get(session.id) as { seq: number };
    const event = sessionEventSchema.parse({ sessionId: session.id, seq, type, version: 1,
      timestamp: new Date().toISOString(), payload: { runId } });
    db.prepare(`insert into session_events(session_id,seq,type,version,timestamp,payload)
      values(?,?,?,?,?,?)`).run(session.id,seq,type,1,event.timestamp,JSON.stringify(event.payload));
    events.push(event);
  }
  db.prepare("update sessions set status='cancelled',updated_at=? where id=? and run_id=? and status<>'cancelled'")
    .run(new Date().toISOString(),session.id,runId);
  return { sessionId: session.id, events };
}

/** Only called after the transaction has won recovery admission. */
export function handOffInterruptedExecutionTxn(db: TekonDatabase, runId: string, confirmation: ResumeConfirmation, previousJobId: string | null, jobId: string): void {
  const now = new Date().toISOString();
  // Keep completed Agent + Gate position; only unfinished Agents restart.
  db.prepare(`update nodes set status='interrupted',updated_at=? where run_id=? and status='running'
    and not exists (select 1 from role_runs r where r.id=(select r2.id from role_runs r2
      where r2.run_id=nodes.run_id and r2.node_id=nodes.id order by r2.started_at desc,r2.id desc limit 1)
      and r.status='passed' and r.completed_at is not null)`).run(now,runId);
  db.prepare("update role_runs set status='interrupted',interrupted_at=? where run_id=? and status='running'")
    .run(now,runId);
  if (confirmation.confirmStopped) appendAuditEventTxn(db, { runId, type: 'run.resume-exit-confirmed',
    payload: { previousJobId, jobId, source: 'human-confirmation', managedExitObserved: false } });
}
