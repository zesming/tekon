import { afterEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { openTekonDatabase } from '@tekon/core';
import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(withJob = true) {
  const fixture = await createWebFixtureProject();
  cleanups.push(fixture.cleanup);
  const db = openTekonDatabase({ filename: join(fixture.projectRoot, '.tekon', 'tekon.sqlite') });
  cleanups.push(() => { db.close(); });
  const now = new Date().toISOString();
  db.prepare('insert into workspaces (id,root,created_at) values (?,?,?)').run('ws_recovery', fixture.projectRoot, now);
  db.prepare(`insert into sessions (id,workspace_id,title,profile,status,run_id,created_at,updated_at)
    values ('sess_recovery','ws_recovery',null,'human-web','awaiting-input','run_1',?,?)`).run(now, now);
  db.prepare("update workflow_instances set status='interrupted' where id='run_1'").run();
  if (withJob) db.prepare(`insert into jobs (id,session_id,kind,status,owner,lease,abort_state,checkpoint,payload,created_at,updated_at)
    values ('job_old','sess_recovery','workflow-resume','interrupted',null,null,'stopped',null,'{}',?,?)`).run(now, now);
  const api = await createApiCaller({ projectRoot: fixture.projectRoot });
  cleanups.push(() => api.close());
  return { fixture, db, api, input: { runId: 'run_1', token: fixture.sessionToken } };
}

describe('R26 persistent recovery API', () => {
  it('Run, Session and review expose the same unknown exit despite legacy stopped', async () => {
    const { api, db } = await setup();
    const project = db.prepare("select project_id from workflow_instances where id='run_1'").get() as { project_id: string };
    const detail = await api.project.detail({ projectId: project.project_id });
    const run = detail.runs.find((r) => r.id === 'run_1');
    const session = (await api.session.get({ sessionId: 'sess_recovery' })).session;
    const review = await api.review.get({ runId: 'run_1' });
    const expected = { runStatus: 'interrupted', cancelRecovery: null, resumeRecovery: { previousJobId: 'job_old', requiresConfirmation: true } };
    expect(run).toHaveProperty('recovery', expected);
    expect(session).toHaveProperty('recovery', expected);
    expect(session).toHaveProperty('runStatus', 'interrupted');
    expect(review).toHaveProperty('recovery', expected);
  });

  it.each([{}, { confirmStopped: true }, { confirmStopped: true, previousJobId: 'wrong' }])('rejects unsafe approval before writing the decision: %j', async (confirmation) => {
    const { api, db, input } = await setup();
    await expect(api.gate.approve({ ...input, decisionId: 'decision_1', actor: 'reviewer', ...confirmation })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(db.prepare("select status from human_decisions where id='decision_1'").get()).toEqual({ status: 'pending' });
    expect(db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
  });

  it('bare resume rejects unknown exit without enqueueing', async () => {
    const { api, db, input } = await setup();
    db.prepare("update human_decisions set status='approved' where id='decision_1'").run();
    await expect(api.project.resume(input)).rejects.toMatchObject({ code: 'CONFLICT', message: expect.stringContaining('job_old') });
    expect(db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
  });

  it('historical interrupted run without a Job still requires explicit null confirmation', async () => {
    const { api, input } = await setup(false);
    const session = (await api.session.get({ sessionId: 'sess_recovery' })).session;
    expect(session).toHaveProperty('recovery.resumeRecovery', { previousJobId: null, requiresConfirmation: true });
    await expect(api.gate.approve({ ...input, decisionId: 'decision_1', actor: 'reviewer', confirmStopped: true })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('reports recorded approval separately if cancellation wins before enqueue', async () => {
    const { api, db, input } = await setup();
    db.exec(`create trigger cancel_after_approval after update of status on human_decisions
      when new.id='decision_1' and new.status='approved'
      begin update workflow_instances set status='cancelled' where id='run_1'; end`);
    const result = await api.gate.approve({ ...input, decisionId: 'decision_1', actor: 'reviewer', confirmStopped: true, previousJobId: 'job_old' });
    expect(result.decision.status).toBe('approved');
    expect(result).toHaveProperty('resumeOutcome', 'terminal');
    expect(result).toHaveProperty('resumeMessage', expect.stringContaining('尚未恢复'));
    expect(result.jobId).toBeUndefined();
    expect(db.prepare('select count(*) as n from jobs').get()).toEqual({ n: 1 });
  });

  it('preserves the approval receipt if applying its gate result fails', async () => {
    const { api, db, input } = await setup();
    const decision = db.prepare("select gate_result_id from human_decisions where id='decision_1'").get() as { gate_result_id: string | null };
    expect(decision.gate_result_id).toBeTruthy();
    db.exec(`create trigger fail_gate_update before update of status on gate_results
      when new.status='passed' begin select raise(abort,'injected gate write failure'); end`);
    const result = await api.gate.approve({ ...input, decisionId: 'decision_1', actor: 'reviewer', confirmStopped: true, previousJobId: 'job_old' });
    expect(result.decision.status).toBe('approved');
    expect(result).toHaveProperty('resumeOutcome', 'error');
    expect(result).toHaveProperty('resumeMessage', expect.stringContaining('审批已记录，运行尚未恢复'));
    expect(result.jobId).toBeUndefined();
  });
});
