import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureRunPlan, createAuditLogger, createCommandGateway, createGateEngine, createMockAgentAdapter, createRepositories,
  createWorkflowEngine, migrateDatabase, openTekonDatabase,
  parseWorkflowTemplate,
} from '../../src/index.js';
import { validateAndBuildExecutionPlan } from '../../src/workflow/execution-plan.js';

const cleanup: Array<() => void> = [];
afterEach(() => { for (const release of cleanup.splice(0).reverse()) release(); });

function fixture() {
  const repoPath = mkdtempSync(join(tmpdir(), 'tekon-bound-command-'));
  cleanup.push(() => rmSync(repoPath, { recursive: true, force: true }));
  mkdirSync(join(repoPath, '.tekon'));
  writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ scripts: {
    confirmed: 'node -e "process.exit(0)"', changed: 'node -e "process.exit(7)"',
  } }));
  const profilePath = join(repoPath, '.tekon', 'repo-profile.yaml');
  const writeProfile = (entry: unknown) => writeFileSync(profilePath, JSON.stringify({ version: 1, commands: { build: entry } }));
  writeProfile({ tool: 'npm', args: ['run', 'confirmed'] });
  const db = openTekonDatabase({ filename: ':memory:' });
  cleanup.push(() => db.close());
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  const options = { repoPath, dataDir: '.tekon', repositories, audit, adapter: createMockAgentAdapter() };
  const template = parseWorkflowTemplate({ id: 'bound', governance: 'none', phases: [{ id: 'dev', nodes: [{
    id: 'developer', role: 'rd', gates: [{ type: 'build', commandRef: 'build' }],
  }] }] });
  return { db, repoPath, profilePath, writeProfile, repositories, audit, options, template };
}

describe('已受理仓库检查的真实执行绑定', () => {
  it.each([
    ['另一组参数', { tool: 'npm', args: ['run', 'changed'] }],
    ['不适用', { notApplicable: true, reason: 'changed after admission' }],
  ])('受理后配置改为%s，真实 Gate 仍执行确认的命令', async (_label, entry) => {
    const f = fixture();
    const engine = createWorkflowEngine(f.options);
    const prepared = await engine.prepareRun({ demandText: '绑定执行', mode: 'template', workflowSpec: f.template });
    f.writeProfile(entry);
    const workflow = await engine.executePreparedRun(prepared.runId);
    expect(workflow.status).toBe('passed');
    const results = await f.repositories.listGateResults(prepared.runId);
    expect(results.map(result => result.status)).toEqual(['passed']);
    const nodes = await f.repositories.listNodes(prepared.runId);
    expect(nodes[0].gates[0]).toMatchObject({ command: { tool: 'npm', args: ['run', 'confirmed'] } });
    expect(nodes[0].gates[0]).not.toHaveProperty('commandRef');
  });

  it('新 Engine 恢复不读取已损坏的当前 profile', async () => {
    const f = fixture();
    const engine = createWorkflowEngine(f.options);
    const prepared = await engine.prepareRun({ demandText: '绑定恢复', mode: 'template', workflowSpec: f.template });
    await f.repositories.updateWorkflowInstanceStatus(prepared.runId, 'paused', null);
    writeFileSync(f.profilePath, 'SECRET invalid: [');
    const restored = await createWorkflowEngine(f.options).resumeRun(prepared.runId);
    expect(restored.workflow.status).toBe('passed');
    expect((await f.repositories.listGateResults(prepared.runId)).map(result => result.status)).toEqual(['passed']);
  });

  it.each(['missing', 'not-applicable'] as const)('已捕获%s后补入命令，不改变原执行决定', async status => {
    const f = fixture();
    f.writeProfile(status === 'missing' ? undefined : { notApplicable: true, reason: 'confirmed unavailable' });
    const engine = createWorkflowEngine(f.options);
    const prepared = await engine.prepareRun({ demandText: '绑定缺失和不适用', mode: 'template', workflowSpec: f.template });
    f.writeProfile({ tool: 'npm', args: ['run', 'confirmed'] });
    await engine.executePreparedRun(prepared.runId);
    expect((await f.repositories.listGateResults(prepared.runId)).map(result => [result.status, result.failureClassification])).toEqual([
      status === 'missing' ? ['failed', 'missing-command'] : ['skipped', 'not-applicable'],
    ]);
  });

  it('profile删除后，原requestId重放及真实执行仍使用受理事实', async () => {
    const f = fixture(); const engine = createWorkflowEngine(f.options);
    const input = { requestId: 'bound-command-replay-01', demandText: '删除配置后重放', mode: 'template' as const, workflowSpec: f.template };
    const prepared = await engine.prepareRun(input);
    rmSync(f.profilePath);
    const replay = await createWorkflowEngine(f.options).prepareRun(input);
    expect(replay).toMatchObject({ runId: prepared.runId, replayed: true });
    expect((await engine.executePreparedRun(prepared.runId)).status).toBe('passed');
  });

  it('预览后配置变化先于任何受理/Agent/Gate副作用被拒绝', async () => {
    const f = fixture();
    const canonicalPlan = captureRunPlan(f.repoPath, f.template);
    f.writeProfile({ notApplicable: true, reason: 'later' });
    const runAgent = vi.spyOn(f.options.adapter, 'runAgent');
    const engine = createWorkflowEngine({ ...f.options, canonicalPlan });
    await expect(engine.prepareRun({ demandText: '过期确认', mode: 'template', workflowSpec: f.template })).rejects.toThrow(/PLAN_DIGEST_MISMATCH/);
    expect(f.db.prepare('select count(*) as count from run_admissions').get()).toEqual({ count: 0 });
    expect(runAgent).not.toHaveBeenCalled();
  });

  it('已捕获描述符在事务排队窗口不重读profile', async () => {
    const f = fixture(); const engine = createWorkflowEngine(f.options);
    const store = f.repositories.admissionStore;
    const admit = store.admitRun.bind(store);
    vi.spyOn(store, 'admitRun').mockImplementationOnce(async data => {
      f.writeProfile({ notApplicable: true, reason: 'changed while queued' });
      return admit(data);
    });
    const prepared = await engine.prepareRun({ demandText: '排队保留事实', mode: 'template', workflowSpec: f.template });
    expect((await engine.executePreparedRun(prepared.runId)).status).toBe('passed');
    expect((await f.repositories.listGateResults(prepared.runId)).map(result => result.status)).toEqual(['passed']);
  });

  it.each(['command', 'skipReason', 'commandRef'] as const)('持久Gate的%s篡改在Agent和Gate之前拒绝', async field => {
    const f = fixture(); const engine = createWorkflowEngine(f.options);
    const prepared = await engine.prepareRun({ demandText: '检查完整性', mode: 'template', workflowSpec: f.template });
    const node = (await f.repositories.listNodes(prepared.runId))[0];
    const gates = structuredClone(node.gates);
    if (field === 'command') gates[0].command = { tool: 'npm', args: ['run', 'changed'] };
    else if (field === 'skipReason') gates[0].skipReason = 'forged skip';
    else gates[0].commandRef = 'build';
    f.db.prepare('update nodes set gates = ? where id = ?').run(JSON.stringify(gates), node.id);
    const runAgent = vi.spyOn(f.options.adapter, 'runAgent');
    await expect(engine.executePreparedRun(prepared.runId)).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
    expect(runAgent).not.toHaveBeenCalled();
    expect(await f.repositories.listGateResults(prepared.runId)).toEqual([]);
    await f.repositories.updateWorkflowInstanceStatus(prepared.runId, 'paused', null);
    await expect(createWorkflowEngine(f.options).resumeRun(prepared.runId)).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });

  it('repair改变当前profile后仍重试原命令，并保留可验证的repair授权', async () => {
    const f = fixture();
    writeFileSync(join(f.repoPath, 'package.json'), JSON.stringify({ scripts: {
      confirmed: 'node -e "const fs=require(\'fs\');if(!fs.existsSync(\'repair-marker\')){fs.writeFileSync(\'repair-marker\',\'1\');process.exit(7)}"',
      changed: 'node -e "process.exit(8)"',
    } }));
    f.template.phases[0].nodes[0].gates[0].autoFix = true;
    f.template.phases[0].nodes[0].gates[0].maxRetries = 1;
    const mock = createMockAgentAdapter(); let repairs = 0;
    const engine = createWorkflowEngine({ ...f.options, adapter: { async runAgent(input) {
      if (input.runContext.nodeId.startsWith('repair_')) { repairs++; f.writeProfile({ notApplicable: true, reason: 'must not skip repaired check' }); }
      return mock.runAgent(input);
    } } });
    const result = await engine.startRun({ demandText: '修复继承确认', mode: 'template', workflowSpec: f.template });
    expect(result.workflow.status).toBe('passed');
    expect(repairs).toBe(1);
    expect((await f.repositories.listGateResults(result.runId)).map(gate => gate.status)).toEqual(['failed', 'passed']);
    await expect(validateAndBuildExecutionPlan(result.runId, f.repositories, f.audit)).resolves.toBeTruthy();
  });

  it('独立review触发rework后真实构建沿用原命令和稳定Gate身份', async () => {
    const f = fixture();
    const spec = parseWorkflowTemplate({ id: 'bound-rework', phases: [
      { id: 'dev', nodes: [{ id: 'rd', role: 'rd', gates: [{ type: 'build', commandRef: 'build' }] }] },
      { id: 'review', dependsOn: ['dev'], nodes: [{ id: 'reviewer', role: 'reviewer', dependsOn: ['rd'], gates: [{ type: 'independent-review', maxRetries: 1 }] }] },
    ] });
    const actual = createGateEngine({ repositories: f.repositories, gateway: createCommandGateway({ repositories: f.repositories }) });
    let reviews = 0;
    const engine = createWorkflowEngine({ ...f.options, gateEngine: {
      ...actual,
      async runGate(input) {
        if (input.gate.type !== 'independent-review') return actual.runGate(input);
        reviews++;
        f.writeProfile({ notApplicable: true, reason: 'changed by review' });
        return f.repositories.recordGateResult({ id: `gate_${randomUUID()}`, runId: input.runId, nodeId: input.nodeId,
          gateType: 'independent-review', gateKey: input.gate.gateKey,
          status: reviews === 1 ? 'failed' : 'passed', failureClassification: reviews === 1 ? 'changes-requested' : null,
          durationMs: 0, retries: 0, createdAt: new Date().toISOString() });
      },
    } });
    const result = await engine.startRun({ demandText: '返工继承确认', mode: 'template', workflowSpec: spec });
    expect(result.workflow.status).toBe('passed');
    const builds = (await f.repositories.listGateResults(result.runId)).filter(gate => gate.gateType === 'build');
    expect(builds.map(gate => gate.status)).toEqual(['passed', 'passed']);
    expect(builds[0].gateKey).toBe(builds[1].gateKey);
    const nodes = await f.repositories.listNodes(result.runId);
    const derived = nodes.find(node => node.id.endsWith('_rework_1'));
    expect(derived?.gates).toEqual(nodes.find(node => node.id === `${result.runId}_rd`)?.gates);
    await expect(validateAndBuildExecutionPlan(result.runId, f.repositories, f.audit)).resolves.toBeTruthy();
  });
});
