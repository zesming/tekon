import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createAgentRuntime, createCommandGateway, createAuditLogger, createJobRepository, createJobRunner, createMockAgentAdapter,
  createRepositories, createSessionEventBus, createSessionEventStore, createSessionService,
  createSubprocessRegistry, createWorkflowEngine, createWorkflowJobExecutor, createWriteQueue,
  migrateDatabase, openTekonDatabase, type WorkflowTemplate,
} from '../../src/index.js';
import { parallelDatabaseProcesses } from '../db/admission-fixture.js';

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate: () => boolean | Promise<boolean>, timeout = 10000) => {
  const end = Date.now() + timeout;
  while (!await predicate()) { if (Date.now() > end) throw new Error('process lifecycle condition timed out'); await sleep(10); }
};
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A reparented Linux zombie has exited and cannot produce side effects.
    if (process.platform === 'linux') return readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1]?.[0] !== 'Z';
    return true;
  } catch { return false; }
}

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tekon-recovery-process-')));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['init', '-b', 'main']); git(['config', 'user.email', 'test@example.com']); git(['config', 'user.name', 'Recovery test']);
  writeFileSync(join(root, '.gitignore'), '.tekon/\n'); writeFileSync(join(root, 'README.md'), 'Recovery fixture\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({private:true,scripts:{heartbeat:'node '+join(root,'.tekon','heartbeat.mjs')}}));
  git(['add', '.']); git(['commit', '-m', 'fixture']);
  mkdirSync(join(root, '.tekon'));
  const bin = join(root,'.tekon','bin'); mkdirSync(bin);
  const fakeClaude=join(bin,'claude');
  writeFileSync(fakeClaude, '#!'+process.execPath+'\n'+`const fs=require('node:fs');const log=${JSON.stringify(join('/PLACEHOLDER','.tekon'))}.replace('/PLACEHOLDER',${JSON.stringify(root)})+'/'+process.env.TEKON_RUN_ID;
fs.appendFileSync(log+'.starts',process.pid+'\\n');setInterval(()=>{fs.appendFileSync(log,'beat\\n');if(fs.existsSync(log+'.release'))process.exit(0)},20);`);
  chmodSync(fakeClaude,0o755);
  const script = join(root, '.tekon', 'heartbeat.mjs');
  writeFileSync(script, `import {appendFileSync,existsSync,unlinkSync} from 'node:fs';
const log=process.argv[2]; appendFileSync(log+'.starts',process.pid+'\\n');
appendFileSync(log+'.cwds',process.cwd()+'\\n');
if(existsSync(log+'.fail-first')){unlinkSync(log+'.fail-first');process.exit(1)}
setInterval(()=>{appendFileSync(log,'beat\\n');if(existsSync(log+'.release'))process.exit(0)},20);`);
  const processGroups=new Map<number,number>();
  const killTree=(pid:number)=>{process.kill(-(processGroups.get(pid)??pid),'SIGKILL');};
  const filename = join(root, '.tekon', 'tekon.sqlite');
  const db = openTekonDatabase({ filename }); migrateDatabase(db);
  cleanups.push(() => db.close());
  const queue = createWriteQueue(); const repositories = createRepositories(db, queue);
  const sessions = createSessionEventStore(db, queue); const jobs = createJobRepository(db, queue);
  const bus = createSessionEventBus(); const audit = createAuditLogger({ repositories });
  const registry = createSubprocessRegistry();
  const runner = createJobRunner({ jobs, sessions, bus, registry,
    executor: createWorkflowJobExecutor({ repositories, sessions, bus, audit, registry, projectContext: { projectRoot: root } }),
    pollIntervalMs: 10, heartbeatMs: 40, leaseTtlMs: 800 });
  cleanups.push(() => runner.stop());
  const service = createSessionService({ repositories, sessions, jobs, bus, audit, jobRunner: runner, projectRoot: root,
    createEngine: (input: {agent?:boolean}) => {
      const runtime=createAgentRuntime({agent:input.agent?'claude-code':'mock',repoPath:root,gateway:createCommandGateway({repositories})});
      return createWorkflowEngine({ repoPath: root, dataDir: '.tekon', repositories, audit, adapter: runtime.adapter,
        agentProvider:runtime.provider,agentConfigSummary:runtime.configSummary,allowDirtyBase:true });
    } });
  async function start(name: string, agent = false, gateOpts: { onExhausted?: 'block' | 'fail'; autoFix?: boolean; maxRetries?: number } = {}) {
    const log = join(root, '.tekon', name);
    const workflowSpec: WorkflowTemplate = { id: name, name, version: 1,
      retryPolicy: { maxAttempts: 1, backoffMs: 0, strategy: 'fixed', onExhausted: 'block' },
      phases: [{ id: 'phase', name: 'Phase', dependsOn: [], parallel: false, nodes: [{ id: 'node', role: 'rd',
        inputs: [], outputs: [], dependsOn: [], gates: agent ? [] : [{ type: 'test', ...gateOpts, command: { tool: 'npm', args: ['run', 'heartbeat', '--', log] } }] }] }] };
    const run = await service.startRun({ demandText: name, workflowSpec, engine: {agent} });
    return { ...run, log: agent?join(root,'.tekon',run.runId):log };
  }
  const moduleUrl = new URL('../../src/index.ts', import.meta.url).href;
  async function worker(stopBoundary: boolean | 'repair-intent' = false) {
    const source = `process.env.PATH=${JSON.stringify(bin)}+':'+process.env.PATH;
import * as t from ${JSON.stringify(moduleUrl)};
const db=t.openTekonDatabase({filename:${JSON.stringify(filename)}});const q=t.createWriteQueue();
const repositories=t.createRepositories(db,q),sessions=t.createSessionEventStore(db,q),jobs=t.createJobRepository(db,q);
const bus=t.createSessionEventBus(),audit=t.createAuditLogger({repositories}),registry=t.createSubprocessRegistry();
let executionSignal;
const executor=t.createWorkflowJobExecutor({repositories,sessions,bus,audit,registry,projectContext:{projectRoot:${JSON.stringify(root)}}});
const runner=t.createJobRunner({jobs,sessions,bus,registry,pollIntervalMs:10,heartbeatMs:40,leaseTtlMs:800,stopSettleTimeoutMs:20,
executor:{execute(ctx){executionSignal=ctx.signal;return executor.execute(ctx)}}});
const stopBoundary=${JSON.stringify(stopBoundary)};
if(stopBoundary){const append=audit.append.bind(audit);audit.append=async event=>{const saved=await append(event);const boundary=stopBoundary==='repair-intent'?event.type==='gate.repair.intent':event.type==='worktree.lease.released'&&(await repositories.listGateResults(event.runId)).at(-1)?.status==='passed';if(boundary){void runner.stop().then(()=>{db.close();process.disconnect()});if(!executionSignal.aborted)await new Promise(resolve=>executionSignal.addEventListener('abort',resolve,{once:true}))}return saved}}
runner.start();process.send({ready:true});process.on('message',async message=>{if(message==='stop'){await runner.stop();db.close();process.disconnect()}});`;
    const child = spawn(process.execPath, ['--import', fileURLToPath(new URL('../../../../node_modules/tsx/dist/loader.mjs', import.meta.url)), '--input-type=module', '-e', source], { stdio: ['ignore','pipe','pipe','ipc'] });
    let stderr = ''; child.stderr!.on('data', data => { stderr += data; });
    cleanups.push(async () => { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await new Promise(resolve => child.once('exit', resolve)); } });
    await new Promise<void>((resolve,reject) => { child.once('message',()=>resolve()); child.once('error',reject); child.once('exit',()=>reject(new Error(stderr))); });
    return child;
  }
  async function heartbeat(run: { log: string }) {
    try { await waitFor(() => existsSync(run.log) && statSync(run.log).size > 0); } catch (error) { throw new Error(String(error) + JSON.stringify(db.prepare('select * from gate_results').all()) + JSON.stringify((db.prepare('select output_path from gate_results').all() as Array<{output_path:string|null}>).map(r=>r.output_path && existsSync(r.output_path)?readFileSync(r.output_path,'utf8'):r.output_path))); }
    const pid = Number(readFileSync(run.log+'.starts','utf8').trim().split('\n').at(-1));
    processGroups.set(pid,Number(execFileSync('ps',['-o','pgid=','-p',String(pid)],{encoding:'utf8'}).trim()));
    cleanups.push(() => { if (isRunning(pid)) { try { killTree(pid); } catch { /* exited */ } } });
    return pid;
  }
  async function stop(child: ChildProcess) { child.send('stop'); await new Promise(resolve => child.once('exit',resolve)); }
  return { root, filename, db, repositories, sessions, jobs, service, runner, start, worker, heartbeat, stop, killTree };
}

describe('R26 production executor across OS processes', () => {
  it('admits exactly one confirmed resume across independent processes and records one audit', async () => {
    const f=await fixture(); const run=await f.start('resume-race');
    await f.jobs.updateJob(run.jobId,{status:'interrupted',exitEvidence:null});
    await f.repositories.updateWorkflowInstanceStatus(run.runId,'interrupted',null);
    const moduleUrl=new URL('../../src/index.ts',import.meta.url).href;
    const script=`const t=await import(${JSON.stringify(moduleUrl)});const sessions=t.createSessionEventStore(db,writeQueue),jobs=t.createJobRepository(db,writeQueue),bus=t.createSessionEventBus(),audit=t.createAuditLogger({repositories});
const jobRunner=t.createJobRunner({sessions,jobs,bus,registry:t.createSubprocessRegistry(),executor:{execute:async()=>({status:'done'})}});
const service=t.createSessionService({sessions,jobs,bus,audit,jobRunner,repositories,projectRoot:${JSON.stringify(f.root)},createEngine:()=>{throw Error('unexpected')}});
const result=await service.resumeRun({runId:${JSON.stringify(run.runId)},confirmStopped:true,previousJobId:${JSON.stringify(run.jobId)}});process.send({result});`;
    const results=await parallelDatabaseProcesses(f.filename,[script,script]);
    expect(results.map(r=>r.outcome).sort()).toEqual(['enqueued','stale-confirmation']);
    expect((await f.repositories.listAuditEvents(run.runId)).filter(e=>e.type==='run.resume-exit-confirmed')).toHaveLength(1);
  });
  it('cancels a controlled Agent command through the production provider adapter and confirms close', async () => {
    const f=await fixture(); const run=await f.start('agent-cancel',true);
    const owner=await f.worker(); const pid=await f.heartbeat(run);
    await f.service.requestCancel({runId:run.runId});
    await waitFor(async ()=>(await f.jobs.get(run.jobId))?.status==='cancelled' && !isRunning(pid));
    expect((await f.sessions.getRunRecovery(run.runId)).cancelRecovery?.exitStatus).toBe('confirmed');
    const size=statSync(run.log).size; await sleep(100); expect(statSync(run.log).size).toBe(size);
    await f.stop(owner);
  },30000);

  it('normal owner shutdown records real Agent close and a single resume continues the unfinished node', async () => {
    const f=await fixture(); const run=await f.start('agent-stop',true);
    const owner=await f.worker(); const pid=await f.heartbeat(run);
    await f.stop(owner);
    expect(isRunning(pid)).toBe(false);
    expect(await f.jobs.get(run.jobId)).toMatchObject({status:'interrupted',exitEvidence:{version:1,kind:'managed-handles-closed'}});
    expect((await f.sessions.getRunRecovery(run.runId)).resumeRecovery).toEqual({previousJobId:run.jobId,requiresConfirmation:false});
    writeFileSync(run.log+'.release','release');
    const resumed=await f.service.resumeRun({runId:run.runId}); expect(resumed.outcome).toBe('enqueued');
    const restarted=await f.worker();
    await waitFor(async ()=>(await f.repositories.getWorkflowInstance(run.runId))?.status==='passed');
    expect(readFileSync(run.log+'.starts','utf8').trim().split('\n')).toHaveLength(2);
    expect(f.db.prepare("select count(*) as n from role_runs where run_id=? and status='interrupted'").get(run.runId)).toEqual({n:1});
    await f.stop(restarted);
  },30000);
  it.each([
    { onExhausted: 'block' as const },
    { onExhausted: 'fail' as const },
    { onExhausted: 'fail' as const, autoFix: true, maxRetries: 2 },
  ])('normal Gate shutdown preserves completed Agent and resumes only Gate: %j', async gateOpts => {
    const f = await fixture(); const run = await f.start('gate-stop', false, gateOpts);
    const owner = await f.worker(); const pid = await f.heartbeat(run);
    const beforeNodes = await f.repositories.listNodes(run.runId);
    const node = beforeNodes.find(node => node.role === 'rd')!;
    expect(node.status).toBe('awaiting-gate');
    const leases = await f.repositories.listWorktreeLeases(run.runId);
    expect(leases.filter(lease => !lease.releasedAt)).toHaveLength(1);
    await f.stop(owner);
    expect(isRunning(pid)).toBe(false);
    expect(await f.jobs.get(run.jobId)).toMatchObject({ status: 'interrupted', exitEvidence: { kind: 'managed-handles-closed' } });
    expect((await f.repositories.getWorkflowInstance(run.runId))?.status).toBe('interrupted');
    expect((await f.repositories.getNode(node.id))?.status).toBe('awaiting-gate');
    expect(await f.repositories.listWorktreeLeases(run.runId)).toEqual(leases);
    expect(f.db.prepare('select count(*) as n from role_runs where run_id=?').get(run.runId)).toEqual({ n: 1 });
    expect(f.db.prepare("select count(*) as n from role_runs where run_id=? and status='passed'").get(run.runId)).toEqual({ n: 1 });
    expect(await f.repositories.listNodes(run.runId)).toHaveLength(beforeNodes.length);
    const results = await f.repositories.listGateResults(run.runId);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('failed');
    const events = await f.repositories.listAuditEvents(run.runId);
    expect(events.filter(event => event.type === 'gate.execution.interrupted')).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ gateResultId: results[0].id, reason: 'shutdown' }) }),
    ]);
    expect(events.filter(event => ['gate.failed', 'gate.repair.intent', 'gate.repair.created'].includes(event.type))).toHaveLength(0);
    writeFileSync(run.log + '.release', 'release');
    expect(await f.service.resumeRun({ runId: run.runId })).toMatchObject({ outcome: 'enqueued' });
    const restarted = await f.worker();
    await waitFor(async () => (await f.repositories.getWorkflowInstance(run.runId))?.status === 'passed');
    expect(readFileSync(run.log + '.starts', 'utf8').trim().split('\n')).toHaveLength(2);
    expect(f.db.prepare('select count(*) as n from role_runs where run_id=?').get(run.runId)).toEqual({ n: 1 });
    expect((await f.repositories.listGateResults(run.runId)).map(result => result.status)).toEqual(['failed', 'passed']);
    await f.stop(restarted);
  }, 30000);

  it('resumes a post-repair Gate in the same durable repair worktree across hosts', async () => {
    const f = await fixture(); const run = await f.start('repair-gate-stop', false, { onExhausted: 'fail', autoFix: true, maxRetries: 2 });
    writeFileSync(run.log + '.fail-first', 'fail');
    const owner = await f.worker(); await f.heartbeat(run);
    const nodes = await f.repositories.listNodes(run.runId);
    const repair = nodes.find(node => node.id.startsWith('repair_'))!;
    expect(repair.status).toBe('passed');
    const leases = await f.repositories.listWorktreeLeases(run.runId);
    const repairLease = leases.find(lease => lease.nodeId === repair.id && !lease.releasedAt)!;
    expect(repairLease).toBeDefined();
    const artifacts = await f.repositories.listArtifacts(run.runId, repair.id);
    expect(artifacts.length).toBeGreaterThan(0);
    const artifactContents = artifacts.map(artifact => readFileSync(join(f.root, artifact.path), 'utf8'));
    expect(readFileSync(run.log + '.cwds', 'utf8').trim().split('\n').at(-1)).toBe(repairLease.worktreePath);
    await f.stop(owner);
    expect((await f.repositories.getWorkflowInstance(run.runId))?.status).toBe('interrupted');
    expect((await f.repositories.getNode(`${run.runId}_node`))?.status).toBe('awaiting-gate');
    expect(await f.repositories.listWorktreeLeases(run.runId)).toEqual(leases);
    writeFileSync(run.log + '.release', 'release');
    expect(await f.service.resumeRun({ runId: run.runId })).toMatchObject({ outcome: 'enqueued' });
    const restarted = await f.worker();
    await waitFor(async () => (await f.repositories.getWorkflowInstance(run.runId))?.status === 'passed');
    const cwds = readFileSync(run.log + '.cwds', 'utf8').trim().split('\n');
    expect(cwds).toHaveLength(3);
    expect(cwds.slice(1)).toEqual([repairLease.worktreePath, repairLease.worktreePath]);
    expect(cwds).not.toContain(f.root);
    expect(f.db.prepare('select count(*) as n from role_runs where run_id=?').get(run.runId)).toEqual({ n: 1 });
    expect(await f.repositories.listArtifacts(run.runId, repair.id)).toEqual(artifacts);
    expect(artifacts.map(artifact => readFileSync(join(f.root, artifact.path), 'utf8'))).toEqual(artifactContents);
    const afterLeases = await f.repositories.listWorktreeLeases(run.runId);
    expect(afterLeases.map(lease => lease.id)).toEqual(leases.map(lease => lease.id));
    expect(afterLeases.find(lease => lease.id === repairLease.id)?.releasedAt).toBeTruthy();
    await f.stop(restarted);
  }, 30000);

  it.each([false, true])('resumes after completed promotion/release but before node passed (repair=%s)', async repair => {
    const f = await fixture(); const run = await f.start('finalize-stop', false, { onExhausted: 'fail', autoFix: repair, maxRetries: 2 });
    if (repair) writeFileSync(run.log + '.fail-first', 'fail');
    writeFileSync(run.log + '.release', 'release');
    const owner = await f.worker(true);
    await waitFor(() => owner.exitCode !== null || owner.signalCode !== null);
    expect((await f.repositories.getWorkflowInstance(run.runId))?.status).toBe('interrupted');
    expect((await f.repositories.getNode(`${run.runId}_node`))?.status).toBe('awaiting-gate');
    const leases = await f.repositories.listWorktreeLeases(run.runId);
    expect(leases.every(lease => lease.releasedAt)).toBe(true);
    const starts = readFileSync(run.log + '.starts', 'utf8');
    expect(await f.service.resumeRun({ runId: run.runId })).toMatchObject({ outcome: 'enqueued' });
    const restarted = await f.worker();
    await waitFor(async () => (await f.repositories.getWorkflowInstance(run.runId))?.status === 'passed');
    expect(readFileSync(run.log + '.starts', 'utf8')).toBe(starts);
    expect(await f.repositories.listWorktreeLeases(run.runId)).toEqual(leases);
    expect(f.db.prepare('select count(*) as n from role_runs where run_id=?').get(run.runId)).toEqual({ n: 1 });
    await f.stop(restarted);
  }, 30000);

  it('resumes the original lease through repair-intent and post-finalize shutdowns', async () => {
    const f = await fixture(); const run = await f.start('repair-intent-stop', false, { autoFix: true, maxRetries: 2 });
    writeFileSync(run.log + '.fail-first', 'fail');
    const owner = await f.worker('repair-intent');
    await waitFor(() => owner.exitCode !== null || owner.signalCode !== null);
    expect((await f.repositories.getWorkflowInstance(run.runId))?.status).toBe('interrupted');
    expect((await f.repositories.getNode(`${run.runId}_node`))?.status).toBe('awaiting-gate');
    expect((await f.repositories.listNodes(run.runId)).filter(node => node.id.startsWith('repair_'))).toHaveLength(0);
    const leases = await f.repositories.listWorktreeLeases(run.runId);
    expect(leases).toHaveLength(1); expect(leases[0].releasedAt).toBeNull();
    writeFileSync(run.log + '.release', 'release');
    expect(await f.service.resumeRun({ runId: run.runId })).toMatchObject({ outcome: 'enqueued' });
    const restarted = await f.worker(true);
    await waitFor(() => restarted.exitCode !== null || restarted.signalCode !== null);
    expect((await f.repositories.getWorkflowInstance(run.runId))?.status).toBe('interrupted');
    expect((await f.repositories.getNode(`${run.runId}_node`))?.status).toBe('awaiting-gate');
    expect((await f.repositories.listWorktreeLeases(run.runId))[0].releasedAt).toBeTruthy();
    expect(await f.service.resumeRun({ runId: run.runId })).toMatchObject({ outcome: 'enqueued' });
    const finalOwner = await f.worker();
    await waitFor(async () => (await f.repositories.getWorkflowInstance(run.runId))?.status === 'passed');
    expect(readFileSync(run.log + '.cwds', 'utf8').trim().split('\n')).toEqual([leases[0].worktreePath, leases[0].worktreePath]);
    expect(f.db.prepare('select count(*) as n from role_runs where run_id=?').get(run.runId)).toEqual({ n: 1 });
    expect((await f.repositories.listWorktreeLeases(run.runId)).map(lease => lease.id)).toEqual([leases[0].id]);
    await f.stop(finalOwner);
  }, 30000);

  it('concurrent cancellation retries commit exactly one event pair across two independent processes', async () => {
    const f = await fixture(); const run = await f.start('concurrent');
    await f.repositories.updateWorkflowInstanceStatus(run.runId, 'cancelled', null);
    const moduleUrl = new URL('../../src/index.ts', import.meta.url).href;
    const script = `const t=await import(${JSON.stringify(moduleUrl)});const sessions=t.createSessionEventStore(db,writeQueue);
const jobs=t.createJobRepository(db,writeQueue),bus=t.createSessionEventBus(),audit=t.createAuditLogger({repositories});
const jobRunner=t.createJobRunner({sessions,jobs,bus,registry:t.createSubprocessRegistry(),executor:{execute:async()=>({status:'done'})}});
const service=t.createSessionService({sessions,jobs,bus,audit,jobRunner,repositories,projectRoot:${JSON.stringify(f.root)},createEngine:()=>{throw Error('unexpected')}});
await service.requestCancel({runId:${JSON.stringify(run.runId)}});process.send({result:true});`;
    expect(await parallelDatabaseProcesses(f.filename,[script,script])).toEqual([true,true]);
    expect((await f.sessions.listEventsSince(run.sessionId,0)).filter(e=>e.type.startsWith('agent/cancel')).map(e=>e.type))
      .toEqual(['agent/cancel-requested','agent/cancelled']);
    expect((await f.sessions.getSession(run.sessionId))?.status).toBe('cancelled');
  });

  it('cancels the managed Gate process, leaves another Run live, and restart makes no new invocation', async () => {
    const f = await fixture(); const first = await f.start('cancel'); const other = await f.start('other');
    const owner = await f.worker(); const pid = await f.heartbeat(first); const otherPid = await f.heartbeat(other);
    await f.service.requestCancel({ runId: first.runId });
    await waitFor(async () => (await f.jobs.get(first.jobId))?.status === 'cancelled' && !isRunning(pid));
    expect((await f.sessions.getRunRecovery(first.runId)).cancelRecovery?.exitStatus).toBe('confirmed');
    const size = statSync(first.log).size; const otherSize = statSync(other.log).size;
    await sleep(100); expect(statSync(first.log).size).toBe(size); expect(statSync(other.log).size).toBeGreaterThan(otherSize);
    expect(isRunning(otherPid)).toBe(true);
    await f.service.requestCancel({ runId: other.runId }); await f.stop(owner);
    const restarted = await f.worker(); await sleep(1000);
    expect(readFileSync(first.log+'.starts','utf8').trim().split('\n')).toHaveLength(1);
    expect((await f.repositories.getWorkflowInstance(first.runId))?.status).toBe('cancelled');
    await f.stop(restarted);
  }, 30000);

  it('quick restart never repeats an orphaned Gate; one explicit old-Job confirmation resumes at the Gate', async () => {
    const f = await fixture(); const run = await f.start('orphan');
    const owner = await f.worker(); const pid = await f.heartbeat(run);
    owner.kill('SIGKILL'); await new Promise(resolve=>owner.once('exit',resolve));
    expect(isRunning(pid)).toBe(true);
    // Reset to a fresh lease to deterministically exercise restart-before-TTL.
    await f.jobs.updateJob(run.jobId,{lease:new Date().toISOString()});
    const restarted = await f.worker();
    await waitFor(async ()=>(await f.jobs.get(run.jobId))?.status==='interrupted');
    expect(readFileSync(run.log+'.starts','utf8').trim().split('\n')).toHaveLength(1);
    expect(isRunning(pid)).toBe(true);
    expect(await f.service.resumeRun({runId:run.runId})).toMatchObject({outcome:'exit-unconfirmed',previousJobId:run.jobId});
    f.killTree(pid); await waitFor(()=>!isRunning(pid));
    writeFileSync(run.log+'.release','release');
    const resumed=await f.service.resumeRun({runId:run.runId,confirmStopped:true,previousJobId:run.jobId});
    expect(resumed).toMatchObject({outcome:'enqueued',runId:run.runId,sessionId:run.sessionId});
    await waitFor(async ()=>(await f.repositories.getWorkflowInstance(run.runId))?.status==='passed');
    expect(readFileSync(run.log+'.starts','utf8').trim().split('\n')).toHaveLength(2);
    expect(f.db.prepare('select count(*) as n from role_runs where run_id=?').get(run.runId)).toEqual({n:1});
    await f.stop(restarted);
  }, 30000);
});
