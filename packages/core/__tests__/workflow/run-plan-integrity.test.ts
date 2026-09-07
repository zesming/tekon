import { describe, expect, it } from 'vitest';
import { buildPreparedRun as prepareWithCapturedFacts } from '../../src/workflow/execution-plan.js';
import { canonicalJson, computeRunPlanDigest, projectRunPlanV3, projectRunPlanPreview, validateRunPlanV3, type RunPlanContext } from '../../src/workflow/run-plan.js';
import { loadBuiltInWorkflowTemplate, type WorkflowTemplate } from '../../src/workflow/template.js';
import type { BoundRepoCommand } from '../../src/workflow/repo-command-binding.js';

// 本文件测试完整模板/上下文合同；统一使用明确的空仓库捕获fixture，
// 避免缺少repoCommands让拒绝类断言在到达目标字段之前假通过。
function emptyRepoFacts(template: WorkflowTemplate): BoundRepoCommand[] {
  const refs = [...new Set(template.phases.flatMap(phase => phase.nodes.flatMap(node => node.gates.flatMap(gate => gate.commandRef && !gate.command ? [gate.commandRef] : []))))].sort();
  return refs.map(commandRef => ({ commandRef, status: 'missing', source: { kind: 'empty-default', resolverVersion: 1 } }));
}
function projectRunPlan(template: WorkflowTemplate, context: RunPlanContext = {}) {
  return projectRunPlanV3(template, context, emptyRepoFacts(template));
}
function buildPreparedRun(input: Parameters<typeof prepareWithCapturedFacts>[0], options: Parameters<typeof prepareWithCapturedFacts>[1] = {}) {
  return prepareWithCapturedFacts(input, { repoCommands: emptyRepoFacts(input.workflowSpec), ...options });
}

describe('RunPlan v3 的完整确认绑定', () => {
  it('保留经过校验的模板显示别名与版本上下文，仍逐项比较完整投影', () => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const canonicalPlan = projectRunPlan(template, { templateId: 'alias', templateVersion: '2026.9' });
    expect(validateRunPlanV3(canonicalPlan)).toEqual(canonicalPlan);
    const forged = { ...canonicalPlan, phases: [] }; forged.digest = computeRunPlanDigest(forged);
    expect(() => validateRunPlanV3(forged)).toThrow(/PLAN_DIGEST_MISMATCH: projection/);
  });
  it('纯准备绑定请求模板别名与实际模板内容，换别名不能沿用旧确认', () => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const plan = projectRunPlan(template, { templateId: 'alias' });
    const confirmation = { canonicalPlan: plan, planSnapshot: canonicalJson(plan), planDigest: plan.digest };
    const prepared = buildPreparedRun({ workflowSpec: template, templateName: 'alias', ...confirmation }, confirmation);
    expect(prepared.canonicalPlan).toEqual(plan);
    expect(prepared.canonicalPlan.templateId).toBe('alias');
    expect(prepared.template.id).toBe('bugfix');
    expect(() => buildPreparedRun({ workflowSpec: template, templateName: 'another-alias', ...confirmation })).toThrow(/PLAN_DIGEST_MISMATCH/);
  });
  const templateChanges: Array<[string, (template: WorkflowTemplate) => void]> = [
    ['id', t => { t.id += '-v2'; }],
    ['name', t => { t.name += '-v2'; }],
    ['version', t => { t.version++; }],
    ['retryPolicy', t => { t.retryPolicy.backoffMs++; }],
    ['phase.parallel', t => { t.phases[0].parallel = !t.phases[0].parallel; }],
    ['phase.dependsOn', t => { t.phases[1].dependsOn = []; }],
    ['node.role', t => { t.phases[0].nodes[0].role = 'qa'; }],
    ['node.dependsOn', t => { t.phases[1].nodes[0].dependsOn = [t.phases[0].nodes[0].id]; }],
    ['node.inputs', t => { t.phases[1].nodes[0].inputs[0].id += '-v2'; }],
    ['node.outputs', t => { t.phases[0].nodes[0].outputs[0].id += '-v2'; }],
    ['gate.commandRef', t => { t.phases[1].nodes[0].gates[0].commandRef = 'test'; }],
    ['gate.command.args', t => { t.phases[1].nodes[0].gates[0].command = { tool: 'node', args: ['SECRET'] }; }],
    ['gate.command.env.digest', t => { t.phases[1].nodes[0].gates[0].command = { tool: 'node', args: [], env: { digest: 'SECRET' } }; }],
    ['gate.gateKey', t => { t.phases[1].nodes[0].gates[0].gateKey = 'custom-key'; }],
    ['gate.retryPolicy', t => { t.phases[1].nodes[0].gates[0].retryPolicy.backoffMs++; }],
    ['gate.autoFix', t => { t.phases[1].nodes[0].gates[0].autoFix = !t.phases[1].nodes[0].gates[0].autoFix; }],
    ['gate.onExhausted', t => { t.phases[1].nodes[0].gates[0].onExhausted = 'pause'; }],
    ['gate.skipReason', t => { t.phases[1].nodes[0].gates[0].skipReason = 'explicitly unavailable'; }],
  ];
  it.each(templateChanges)('完整模板字段 %s 的改变使确认失效', (_field, mutate) => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const plan = projectRunPlan(template); mutate(template);
    expect(projectRunPlan(template).digest).not.toBe(plan.digest);
    expect(() => buildPreparedRun({ workflowSpec: template, canonicalPlan: plan })).toThrow(/PLAN_DIGEST_MISMATCH/);
  });

  it('等价键顺序和 undefined 不改变绑定，保留规范化 fromNodeId 与 skipReason', () => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    template.phases[1].nodes[0].gates[0].skipReason = 'explicit';
    const plan = projectRunPlan(template);
    const reordered = { ...plan, template: { phases: template.phases, retryPolicy: template.retryPolicy, version: template.version, name: template.name, id: template.id } };
    Object.assign(reordered, { ignored: undefined });
    const result = buildPreparedRun({ workflowSpec: template, canonicalPlan: reordered });
    expect(result.planDigest).toBe(plan.digest);
    expect(result.template.phases[1].nodes[0].inputs).toEqual(template.phases[1].nodes[0].inputs);
    expect(result.template.phases[1].nodes[0].gates[0].skipReason).toBe('explicit');
  });
  it('首次准备兼容 inline gate 的既有缺省字段，快照保存补齐后的执行值', () => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    template.phases[1].nodes[0].gates[0] = { type: 'build' } as never;
    const result = buildPreparedRun({ workflowSpec: template });
    expect(result.template.phases[1].nodes[0].gates[0]).toMatchObject({ type: 'build', requiresHumanApproval: false, maxRetries: 0, retryPolicy: { maxRetries: 0, maxAttempts: 1 } });
    expect(JSON.parse(result.planSnapshot).template).toEqual(result.template);
  });
  it.each(['input', 'options'] as const)('拒绝 %s canonicalPlan 与实际模板不一致', (source) => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const plan = projectRunPlan(template);
    template.phases[0].name = 'changed';
    expect(() => buildPreparedRun({ workflowSpec: template, ...(source === 'input' ? { canonicalPlan: plan } : {}) }, source === 'options' ? { canonicalPlan: plan } : {})).toThrow(/PLAN_DIGEST_MISMATCH/);
  });

  it.each(['canonicalPlan', 'planSnapshot', 'planDigest'] as const)('校验 input/options 每一份 %s，不因优先级忽略冲突', (field) => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const plan = projectRunPlan(template);
    const other = projectRunPlan(template, { mode: 'goal' });
    const values = { canonicalPlan: [plan, other], planSnapshot: [JSON.stringify(plan), JSON.stringify(other)], planDigest: [plan.digest, other.digest] };
    const [first, second] = values[field];
    expect(() => buildPreparedRun({ workflowSpec: template, [field]: first }, { [field]: second })).toThrow(/PLAN_DIGEST_MISMATCH/);
  });

  it.each(['mode', 'roleChain', 'gates', 'phases', 'requiresUnrestrictedNetwork', 'templateId', 'templateVersion'] as const)('拒绝自行重算 digest 的伪造展示字段 %s', (field) => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const plan = projectRunPlan(template);
    const changes = { mode: 'goal', roleChain: [], gates: [], phases: [], requiresUnrestrictedNetwork: true, templateId: 'another', templateVersion: 42 };
    const forged = { ...plan, [field]: changes[field] };
    forged.digest = computeRunPlanDigest(forged);
    expect(() => buildPreparedRun({ workflowSpec: template, canonicalPlan: forged })).toThrow(/PLAN_DIGEST_MISMATCH/);
  });

  it('真实执行上下文同样参与确认比较', () => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const plan = projectRunPlan(template, { agent: 'codex', timeoutMs: 100 });
    expect(() => buildPreparedRun({ workflowSpec: template, canonicalPlan: plan }, { agentProvider: 'dsh-headless', timeoutMs: 200 })).toThrow(/PLAN_DIGEST_MISMATCH/);
  });

  it.each([undefined, 1, 2, 4])('新确认拒绝旧/未知 digestVersion=%s', (version) => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const plan = { ...projectRunPlan(template), digestVersion: version };
    plan.digest = computeRunPlanDigest(plan);
    expect(() => buildPreparedRun({ workflowSpec: template, canonicalPlan: plan as never })).toThrow(/PLAN_DIGEST_MISMATCH/);
  });

  it('规范化 snapshot 必须带自洽 digest；持久化使用重新序列化副本', () => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const plan = projectRunPlan(template);
    expect(() => buildPreparedRun({ workflowSpec: template }, { planSnapshot: JSON.stringify({ ...plan, digest: 'SECRET' }) })).toThrow(/PLAN_DIGEST_MISMATCH/);
    const prepared = buildPreparedRun({ workflowSpec: template, planSnapshot: JSON.stringify(plan, null, 4) });
    expect(prepared.planSnapshot).toBe(canonicalJson(plan));
  });

  it('同步准备对模板与调用方确认对象均深拷贝', () => {
    const template = loadBuiltInWorkflowTemplate('bugfix');
    const canonicalPlan = projectRunPlan(template);
    const prepared = buildPreparedRun({ workflowSpec: template, canonicalPlan });
    canonicalPlan.phases[0].nodeIds.length = 0;
    canonicalPlan.template.phases[0].name = 'changed';
    template.phases[0].nodes[0].gates.length = 0;
    expect(prepared.planDigest).toBe(computeRunPlanDigest(prepared.canonicalPlan));
    expect(prepared.template).toEqual(prepared.canonicalPlan.template);
  });

  it('公开 preview 的嵌套结构同样使用白名单且不共享引用', () => {
    const plan = projectRunPlan(loadBuiltInWorkflowTemplate('bugfix'));
    Object.assign(plan.gates[0], { command: { env: { key: 'SECRET' } } });
    Object.assign(plan.phases[0], { secret: 'SECRET' });
    const preview = projectRunPlanPreview(plan);
    expect(JSON.stringify(preview)).not.toContain('SECRET');
    preview.phases[0].nodeIds.length = 0;
    expect(plan.phases[0].nodeIds.length).toBeGreaterThan(0);
  });
});
