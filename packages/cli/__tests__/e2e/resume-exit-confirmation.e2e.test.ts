import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { openTekonDatabase } from '@tekon/core';

const cliPath = fileURLToPath(new URL('../../dist/index.js', import.meta.url));
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function run(repo: string, args: string[]) {
  const result = spawnSync(process.execPath, [cliPath, ...args, '--repo', repo], { cwd: repo, encoding: 'utf8', timeout: 25_000 });
  expect(result.error).toBeUndefined();
  return result;
}
function fixture(historical = false) {
  const repo = mkdtempSync(join(tmpdir(), 'tekon-r26-cli-'));
  roots.push(repo);
  for (const args of [['init','-b','main'], ['config','user.email','test@tekon.local'], ['config','user.name','Tekon Test']]) execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node -e "process.exit(0)"' } }));
  execFileSync('git', ['add','.'], { cwd: repo, stdio: 'pipe' });
  execFileSync('git', ['commit','-m','fixture'], { cwd: repo, stdio: 'pipe' });
  expect(run(repo, ['init']).status).toBe(0);
  const started = run(repo, ['run','验证中断恢复','--goal','--agent','mock']);
  expect(started.status, started.stderr).toBe(0);
  const db = openTekonDatabase({ filename: join(repo,'.tekon','tekon.sqlite') });
  const { id: runId } = db.prepare('select id from workflow_instances').get() as { id: string };
  const { id: jobId } = db.prepare("select id from jobs where kind in ('workflow-run','workflow-resume','goal-run') order by created_at desc,id desc limit 1").get() as { id: string };
  db.prepare("update workflow_instances set status='interrupted' where id=?").run(runId);
  db.prepare("update jobs set status='interrupted',owner=null,lease=null,abort_state='stopped',exit_evidence=null where id=?").run(jobId);
  if (historical) {
    db.prepare('delete from run_admissions where run_id=?').run(runId);
    db.prepare('delete from jobs').run();
  }
  return { repo, db, runId, jobId };
}

describe('R26 CLI recovery confirmation through a real process', () => {
  it.each([false, true])('requires identity-bound confirmation then resumes the same Run once (historical=%s)', (historical) => {
    const { repo, db, runId, jobId } = fixture(historical);
    try {
      const args = ['resume','--run-id',runId];
      const unconfirmed = run(repo,args);
      expect(unconfirmed.status).toBe(1);
      expect(unconfirmed.stderr).toContain('退出未确认');
      const missing = run(repo,[...args,'--confirm-stopped']);
      expect(missing.status).toBe(1);
      const stale = run(repo,[...args,'--confirm-stopped','--previous-job-id','wrong-job']);
      expect(stale.status).toBe(1);
      expect(stale.stderr).toContain('确认已过期');
      const accepted = run(repo,[...args,'--confirm-stopped','--previous-job-id',historical ? 'none' : jobId]);
      expect(accepted.status,accepted.stderr).toBe(0);
      expect(accepted.stdout, JSON.stringify(db.prepare('select type,payload from audit_events order by created_at desc limit 8').all())).toContain(`runId=${runId} status=passed`);
      expect(db.prepare('select count(*) as n from workflow_instances').get()).toEqual({n:1});
      expect(db.prepare("select count(*) as n from audit_events where type='run.resume-exit-confirmed'").get()).toEqual({n:1});
    } finally { db.close(); }
  }, 60_000);

  it('does not let --approve-human record a decision when old exit is unknown', () => {
    const { repo, db, runId } = fixture();
    try {
      const node = db.prepare('select id from nodes where run_id=? limit 1').get(runId) as {id:string};
      db.prepare("insert into human_decisions(id,run_id,node_id,status,created_at) values ('r26_decision',?,?,'pending',?)").run(runId,node.id,new Date().toISOString());
      const result = run(repo,['resume','--approve-human','--run-id',runId,'--decision-id','r26_decision']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('退出未确认');
      expect(db.prepare("select status from human_decisions where id='r26_decision'").get()).toEqual({status:'pending'});
      expect(db.prepare("select count(*) as n from jobs where kind='workflow-resume'").get()).toEqual({n:0});
    } finally { db.close(); }
  }, 60_000);
});
