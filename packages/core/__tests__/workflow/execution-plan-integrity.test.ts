import { afterEach, describe, expect, it } from 'vitest';
import { openTekonDatabase } from '../../src/db/connection.js';
import { migrateDatabase } from '../../src/db/migrations.js';
import { createRepositories } from '../../src/db/repositories.js';
import { createAuditLogger } from '../../src/audit/logger.js';
import { persistPlan, templateToPlan, runPlanToExecutionPlan, validateAndBuildExecutionPlan } from '../../src/workflow/execution-plan.js';
import { canonicalJson, canonicalJsonV1, computeRunPlanDigest, computeRunPlanDigestV1, projectRunPlan, projectRunPlanV3 } from '../../src/workflow/run-plan.js';
import { parseWorkflowTemplate } from '../../src/workflow/template.js';
import type { ExecutableNode } from '../../src/workflow/workflow-runtime.js';

const openDbs: ReturnType<typeof openTekonDatabase>[] = [];
afterEach(() => { for (const db of openDbs.splice(0)) db.close(); });
async function fixture(autoFixReview = false, version: 2 | 3 = 2) {
  const db = openTekonDatabase({ filename: ':memory:' }); openDbs.push(db); migrateDatabase(db);
  const repositories = createRepositories(db); const audit = createAuditLogger({ repositories });
  const now = new Date().toISOString(); const runId = 'integrity-run';
  const template = parseWorkflowTemplate({ id: 'integrity', phases: [
    { id: 'dev', nodes: [{ id: 'source', role: 'rd', gates: [{ type: 'build', autoFix: true, maxRetries: 2, command: { tool: 'node', args: [], env: { digest: 'secret' }, match: 'exact' } }] }] },
    { id: 'review', dependsOn: ['dev'], nodes: [{ id: 'reviewer', role: 'reviewer', gates: [{ type: 'independent-review', maxRetries: 3, ...(autoFixReview ? { autoFix: true } : {}) }], dependsOn: ['source'] }] },
  ] });
  if (version === 3) {
    delete template.phases[0].nodes[0].gates[0].command;
    template.phases[0].nodes[0].gates[0].commandRef = 'build';
  }
  const canonical = version === 2 ? projectRunPlan(template) : projectRunPlanV3(template, {}, [{
    commandRef: 'build', status: 'resolved', command: { tool: 'npm', args: ['run', 'confirmed'] },
    source: { kind: 'repo-profile', resolverVersion: 1, profileVersion: 1, path: '.tekon/repo-profile.yaml' },
  }]);
  await repositories.createProject({ id: 'p', name: 'p', repoPath: '/tmp/integrity', createdAt: now });
  await repositories.createDemand({ id: 'd', title: 'd', body: 'd', createdAt: now });
  await repositories.createWorkflowInstance({ id: runId, projectId: 'p', demandId: 'd', status: 'paused', planSnapshot: canonicalJson(canonical), planDigest: canonical.digest, createdAt: now, updatedAt: now });
  const plan = version === 2 ? templateToPlan(template, runId) : runPlanToExecutionPlan(canonical, runId); await persistPlan(runId, plan, repositories);
  await audit.append({ runId, type: 'run.started', payload: {} });
  const source = plan.phases[0].nodes[0]; const review = plan.phases[1].nodes[0];
  const verify = () => validateAndBuildExecutionPlan(runId, repositories, audit);
  async function addResult(id: string, node = review, overrides: Record<string, unknown> = {}) {
    return repositories.recordGateResult({ id, runId, nodeId: node.id, gateType: node.gates[0].type, gateKey: node.gates[0].gateKey, status: 'failed', failureClassification: 'changes-requested', durationMs: 0, retries: 0, createdAt: now, ...overrides });
  }
  async function addNode(node: ExecutableNode, order = 1_000_000) {
    return repositories.createNode({ ...node, runId, status: 'pending', dependencies: node.dependsOn, order, createdAt: now, updatedAt: now });
  }
  async function rework(target = source, attempt = 1, options: { needs?: boolean; attemptEvent?: boolean; create?: boolean; overrides?: Record<string, unknown> } = {}) {
    const result = await addResult(`review-result-${attempt}-${target.id}`);
    const node: ExecutableNode = { ...structuredClone(target), id: `${target.id}_rework_${attempt}`, dependsOn: [review.id] };
    const payload = { reviewNodeId: review.id, targetNodeId: target.id, gateResultId: result.id, attempt, reworkNodeId: node.id, ...options.overrides };
    if (options.needs !== false) await audit.append({ runId, type: 'gate.rework.needs-revision', payload });
    if (options.attemptEvent !== false) await audit.append({ runId, type: 'gate.rework.attempt', payload });
    if (options.create !== false) await addNode(node);
    return node;
  }
  async function repair(options: { overrides?: Record<string, unknown>; resultOverrides?: Record<string, unknown>; create?: boolean; intent?: boolean } = {}) {
    const result = await addResult('repair-result', source, { failureClassification: 'exit-nonzero', ...options.resultOverrides });
    const node: ExecutableNode = { id: `repair_${result.id}`, role: source.role, inputs: [], outputs: [], gates: [], dependsOn: [source.id] };
    if (options.intent !== false) await audit.append({ runId, type: 'gate.repair.intent', payload: { sourceNodeId: source.id, repairNodeId: node.id, gateResultId: result.id, gateType: 'build', gateKey: source.gates[0].gateKey, fixerRole: source.role, attempt: 1, maxAttempts: 2, ...options.overrides } });
    if (options.create !== false) await addNode(node, 0);
    return node;
  }
  return { db, repositories, audit, now, runId, template, canonical, plan, source, review, verify, addNode, addResult, rework, repair };
}

describe('v2 原始持久化计划完整性', () => {
  it('允许合法 pending/running/interrupted 状态，返回一次读取验证过的 plan', async () => {
    const f = await fixture(); f.db.prepare("update nodes set status = 'interrupted'").run();
    expect(await f.verify()).toEqual(f.plan);
  });
  it('v2 无法读取原始字段时拒绝使用会补默认值的 repository 投影', async () => {
    const f = await fixture(); f.repositories.getDatabase = undefined;
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED: repository.rawExecutionRows/);
  });
  it.each(['autoFix', 'onExhausted', 'retryPolicy', 'skipReason', 'command.match', 'command.env.digest', 'requiresHumanApproval', 'gateKey'])('拒绝原始 gate 字段篡改/删除 %s', async (field) => {
    const f = await fixture(); const gates = structuredClone(f.source.gates);
    if (field === 'command.match') gates[0].command!.match = 'prefix';
    else if (field === 'command.env.digest') gates[0].command!.env!.digest = 'changed';
    else if (field === 'skipReason') gates[0].skipReason = 'skip';
    else delete (gates[0] as unknown as Record<string, unknown>)[field];
    f.db.prepare('update nodes set gates = ? where id = ?').run(JSON.stringify(gates), f.source.id);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it.each(['phase_order', 'node_order'])('拒绝即使排序相同的原始 %s 变化', async (field) => {
    const f = await fixture();
    if (field === 'phase_order') f.db.prepare('update phases set phase_order = phase_order + 5').run();
    else f.db.prepare('update nodes set node_order = node_order + 5').run();
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it('拒绝孤立节点和损坏的审计链', async () => {
    const f = await fixture(); await f.addNode({ ...f.source, id: 'forged_rework_1', phaseId: undefined });
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
    f.db.prepare('delete from nodes where id = ?').run('forged_rework_1');
    f.db.prepare('update audit_events set hash = ?').run('broken');
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it('损坏的审计 JSON 使用脱敏完整性错误，不透传原始解析内容', async () => {
    const f = await fixture(); f.db.prepare('update audit_events set payload = ?').run('SECRET_SENTINEL');
    const error = await f.verify().catch(cause => cause as Error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/^PLAN_VERIFICATION_FAILED: [\w.]+$/);
    expect((error as Error).message).not.toContain('SECRET_SENTINEL');
  });
  it.each(['missing-node', 'missing-phase', 'unknown-phase', 'inputs', 'outputs', 'dependencies', 'role', 'phaseId'])('拒绝原始执行结构损坏 %s', async field => {
    const f = await fixture();
    if (field === 'missing-node') f.db.prepare('delete from nodes where id = ?').run(f.source.id);
    else if (field === 'missing-phase') { f.db.prepare('delete from nodes where phase_id = ?').run(f.plan.phases[0].id); f.db.prepare('delete from phases where id = ?').run(f.plan.phases[0].id); }
    else if (field === 'unknown-phase') await f.repositories.createPhase({ id: 'extra-phase', runId: f.runId, name: 'extra', order: 2, status: 'pending', createdAt: f.now, updatedAt: f.now });
    else if (field === 'inputs') f.db.prepare('update nodes set inputs = ? where id = ?').run('[{"id":"x","type":"prd","fromNodeId":"missing"}]', f.source.id);
    else if (field === 'outputs') f.db.prepare('update nodes set outputs = ? where id = ?').run('[{"id":"x","type":"prd"}]', f.source.id);
    else if (field === 'dependencies') f.db.prepare('update nodes set dependencies = ? where id = ?').run('["missing"]', f.source.id);
    else if (field === 'role') f.db.prepare('update nodes set role = ? where id = ?').run('qa', f.source.id);
    else f.db.prepare('update nodes set phase_id = ? where id = ?').run(f.plan.phases[1].id, f.source.id);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it('拒绝自行重算的 mode/派生展示摘要，与 Workflow.kind 比较', async () => {
    const f = await fixture(); const changed = { ...f.canonical, mode: 'goal' as const, roleChain: [] }; changed.digest = computeRunPlanDigest(changed);
    f.db.prepare('update workflow_instances set plan_snapshot = ?, plan_digest = ?').run(JSON.stringify(changed), changed.digest);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
});

describe('v3继承物化检查的派生来源', () => {
  it('rework及嵌套rework继承同一无ref命令，repair不新增检查', async () => {
    const f = await fixture(false, 3);
    const one = await f.rework(); const two = await f.rework(one, 2);
    const repair = await f.repair();
    const verified = await f.verify();
    const nodes = verified.phases[0].nodes;
    expect(nodes.map(node => node.id)).toEqual([f.source.id, one.id, two.id]);
    for (const node of nodes) {
      expect(node.gates).toEqual(f.source.gates);
      expect(node.gates[0]).not.toHaveProperty('commandRef');
      expect(node.gates[0].command).toEqual({ tool: 'npm', args: ['run', 'confirmed'] });
    }
    expect(repair.gates).toEqual([]);
    const forged = structuredClone(two.gates); forged[0].commandRef = 'build';
    f.db.prepare('update nodes set gates = ? where id = ?').run(JSON.stringify(forged), two.id);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
});

describe('审计授权的 rework / repair 派生图', () => {
  it('合法返工与嵌套返工按授权顺序追加，不要求 completed', async () => {
    const f = await fixture(); const one = await f.rework(); const two = await f.rework(one, 2);
    expect((await f.verify()).phases[0].nodes.map(n => n.id)).toEqual([f.source.id, one.id, two.id]);
  });
  it('允许只有意图且尚未创建的合法窗口', async () => {
    const f = await fixture(); await f.rework(f.source, 1, { create: false }); await f.repair({ create: false });
    expect(await f.verify()).toEqual(f.plan);
  });
  it.each(['gate.rework.attempt', 'gate.rework.needs-revision'])('允许只有 %s 事件且未落节点', async type => {
    const f = await fixture(); const result = await f.addResult('review-intent-only');
    await f.audit.append({ runId: f.runId, type, payload: { reviewNodeId: f.review.id, targetNodeId: f.source.id, gateResultId: result.id, attempt: 1, reworkNodeId: `${f.source.id}_rework_1` } });
    expect(await f.verify()).toEqual(f.plan);
  });
  it.each([{ needs: false }, { attemptEvent: false }, { overrides: { attempt: 1.5 } }, { overrides: { attempt: 99 } }, { overrides: { gateResultId: 'missing' } }])('拒绝缺少完整授权或非法次数的返工 %j', async options => {
    const f = await fixture(); await f.rework(f.source, 1, options);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it('逐字段验证派生节点 gates 和 order', async () => {
    const f = await fixture(); const node = await f.rework();
    f.db.prepare('update nodes set gates = ? where id = ?').run('[]', node.id);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
    f.db.prepare('update nodes set gates = ?, node_order = 0 where id = ?').run(JSON.stringify(node.gates), node.id);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it('拒绝跨 Run 结果和同类型但不同 gateKey 的返工', async () => {
    const f = await fixture(); await f.rework();
    f.db.prepare('update gate_results set gate_key = ?').run('different-key');
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
    await f.repositories.createWorkflowInstance({ id: 'other-run', projectId: 'p', demandId: 'd', status: 'running', createdAt: f.now, updatedAt: f.now });
    f.db.prepare('update gate_results set gate_key = ?, run_id = ?').run(f.review.gates[0].gateKey, 'other-run');
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it('拒绝尚未授权的派生节点循环自证和悬空授权来源', async () => {
    const f = await fixture(); const forged = { ...f.source, id: `${f.source.id}_rework_1` };
    await f.addNode(forged); await f.rework(forged, 2);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it('repair 及 repair→无 phase rework 都合法，但不进入 workflow 调度', async () => {
    const f = await fixture(); const repair = await f.repair(); await f.rework(repair);
    expect(await f.verify()).toEqual(f.plan);
  });
  it('independent-review 的 repair agent 失败后，可由同一失败结果转入 rework', async () => {
    const f = await fixture(true); const result = await f.addResult('repair-then-rework');
    const repair: ExecutableNode = { id: `repair_${result.id}`, role: f.review.role, inputs: [], outputs: [], gates: [], dependsOn: [f.review.id] };
    await f.audit.append({ runId: f.runId, type: 'gate.repair.intent', payload: { sourceNodeId: f.review.id, repairNodeId: repair.id, gateResultId: result.id, gateType: 'independent-review', gateKey: f.review.gates[0].gateKey, fixerRole: f.review.role, attempt: 3, maxAttempts: 3 } });
    await f.addNode(repair, 0);
    const rework: ExecutableNode = { ...f.source, id: `${f.source.id}_rework_1`, dependsOn: [f.review.id] };
    const payload = { reviewNodeId: f.review.id, targetNodeId: f.source.id, gateResultId: result.id, attempt: 1, reworkNodeId: rework.id };
    await f.audit.append({ runId: f.runId, type: 'gate.rework.attempt', payload });
    await f.audit.append({ runId: f.runId, type: 'gate.rework.needs-revision', payload });
    await f.addNode(rework);
    expect((await f.verify()).phases[0].nodes.map(node => node.id)).toEqual([f.source.id, rework.id]);
  });
  it.each([
    { overrides: { fixerRole: 'qa' } }, { overrides: { gateKey: 'forged' } }, { overrides: { gateType: 'test' } },
    { overrides: { repairNodeId: 'forged' } }, { overrides: { attempt: 3 } }, { overrides: { maxAttempts: 99 } },
    { resultOverrides: { nodeId: 'integrity-run_reviewer' } }, { resultOverrides: { status: 'passed' } }, { intent: false },
  ])('拒绝伪造 repair 来源 %j', async options => {
    const f = await fixture(); await f.repair(options);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it('拒绝 repair 中偷偷加入 phase/gates/outputs', async () => {
    const f = await fixture(); const repair = await f.repair(); f.db.prepare('update nodes set phase_id = ? where id = ?').run(f.plan.phases[0].id, repair.id);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
    f.db.prepare('update nodes set phase_id = null, outputs = ? where id = ?').run('[{"id":"x","type":"prd"}]', repair.id);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
});

describe('历史计划严格兼容边界', () => {
  // 基线 canonicalJson 会递归删除 digest；真实持久快照本身不含 digest。
  const legacySnapshot = '{"agent":"codex","gates":[],"phases":[{"id":"dev","name":"Development","nodeIds":["source"],"parallel":false}],"requiresUnrestrictedNetwork":false,"roleChain":["rd"],"templateId":"legacy","templateVersion":1}';
  const legacyDigest = 'e0f599e86688d6a862558e330c3466cc0e22fe5539f9a2015aa6c9191cfe920a';
  it('无 admission 无计划的历史 Run 仍可恢复', async () => {
    const f = await fixture(); f.db.prepare('update workflow_instances set plan_snapshot = null, plan_digest = null').run();
    expect(await f.verify()).toEqual(f.plan);
  });
  it('自动查 admission，防止双字段丢失时降级 legacy', async () => {
    const f = await fixture(); f.db.prepare("insert into run_admissions (request_id,envelope_version,envelope_hash,run_id,data_dir,files_state,created_at,updated_at) values ('request-id',1,'hash',?,'.tekon','ready',?,?)").run(f.runId,f.now,f.now);
    f.db.prepare('update workflow_instances set plan_snapshot = null, plan_digest = null').run();
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it('冻结 v1 算法验证历史摘要', async () => {
    const f = await fixture(); const old = { roleChain: ['rd'], digest: 'ignored', nested: { digest: 'old' } }; const digest = computeRunPlanDigestV1(old); old.digest = digest;
    f.db.prepare('update workflow_instances set plan_snapshot = ?, plan_digest = ?').run(JSON.stringify(old), digest);
    expect(await f.verify()).toEqual(f.plan);
  });
  it('恢复基线 canonicalJsonV1 产生的不含 digest 的真实历史快照', async () => {
    const f = await fixture();
    expect(canonicalJsonV1({ ...JSON.parse(legacySnapshot), digest: legacyDigest })).toBe(legacySnapshot);
    expect(computeRunPlanDigestV1(JSON.parse(legacySnapshot))).toBe(legacyDigest);
    expect(JSON.parse(legacySnapshot)).not.toHaveProperty('digest');
    f.db.prepare('update workflow_instances set plan_snapshot = ?, plan_digest = ?').run(legacySnapshot, legacyDigest);
    expect(await f.verify()).toEqual(f.plan);
  });
  it.each(['database', 'snapshot'] as const)('v1 的 %s digest 存在但错误时仍拒绝', async source => {
    const f = await fixture();
    const snapshot = source === 'snapshot' ? JSON.stringify({ ...JSON.parse(legacySnapshot), digest: 'wrong' }) : legacySnapshot;
    f.db.prepare('update workflow_instances set plan_snapshot = ?, plan_digest = ?').run(snapshot, source === 'database' ? 'wrong' : legacyDigest);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED: legacy.digest/);
  });
  it.each([1, 99, null])('未知显式版本 %s 不能作为 v1', async version => {
    const f = await fixture(); const old = { digestVersion: version, digest: '' }; old.digest = computeRunPlanDigestV1(old);
    f.db.prepare('update workflow_instances set plan_snapshot = ?, plan_digest = ?').run(JSON.stringify(old), old.digest);
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
  });
  it.each(['missing-snapshot', 'missing-digest', 'invalid-json', 'null-json', 'v2-wrong-digest'])('计划缺损必须 fail-closed: %s', async corruption => {
    const f = await fixture();
    if (corruption === 'missing-snapshot') f.db.prepare('update workflow_instances set plan_snapshot = null').run();
    else if (corruption === 'missing-digest') f.db.prepare('update workflow_instances set plan_digest = null').run();
    else if (corruption === 'invalid-json') f.db.prepare('update workflow_instances set plan_snapshot = ?').run('{SECRET');
    else if (corruption === 'null-json') f.db.prepare('update workflow_instances set plan_snapshot = ?').run('null');
    else f.db.prepare('update workflow_instances set plan_digest = ?').run('SECRET');
    await expect(f.verify()).rejects.toThrow(/PLAN_VERIFICATION_FAILED/);
    await expect(f.verify()).rejects.not.toThrow(/SECRET/);
  });
});
