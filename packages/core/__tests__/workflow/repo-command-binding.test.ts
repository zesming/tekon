import { createHmac } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  captureRepoCommands, type BoundRepoCommand,
} from '../../src/workflow/repo-command-binding.js';
import {
  canonicalJson, captureRunPlan, classifyExecutionBinding, computeRunPlanDigest, computeRunPlanDigestV1,
  projectRunPlanV2, projectRunPlanV3, projectRunPlanPreview, validateRunPlanV3,
} from '../../src/workflow/run-plan.js';
import { buildPreparedRun, runPlanToExecutionPlan, templateToPlan } from '../../src/workflow/execution-plan.js';
import { parseWorkflowTemplate, type WorkflowGateConfig } from '../../src/workflow/template.js';

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks(); });
function repo(profile?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'tekon-command-facts-')); dirs.push(root);
  mkdirSync(join(root, '.tekon'));
  if (profile !== undefined) writeFileSync(join(root, '.tekon/repo-profile.yaml'), JSON.stringify(profile));
  return root;
}
function template(gates: Array<Partial<WorkflowGateConfig>> = [{ type: 'build', commandRef: 'build' }]) {
  const result = parseWorkflowTemplate({ id: 'facts', governance: 'none', phases: [{ id: 'dev', nodes: [{ id: 'rd', role: 'rd', gates: gates.map(({ skipReason: _skip, ...gate }) => gate) }] }] });
  gates.forEach((gate, index) => { if (gate.skipReason) result.phases[0].nodes[0].gates[index].skipReason = gate.skipReason; });
  return result;
}
const source = { kind: 'repo-profile' as const, resolverVersion: 1 as const, profileVersion: 1, path: '.tekon/repo-profile.yaml' as const };
const resolved: BoundRepoCommand = { commandRef: 'build', source, status: 'resolved', command: { tool: 'npm', args: ['run', 'build'] } };

describe('有效仓库命令捕获', () => {
  it('单次读取只绑定消费的ref，内联优先、排序去重、无关字段不进入摘要', () => {
    const root = repo({ version: 2, commands: { build: { tool: 'npm', args: ['run', 'build'], description: 'first' }, test: { tool: 'npm', args: ['test'] } } });
    const spec = template([{ type: 'build', commandRef: 'build' }, { type: 'lint', commandRef: 'build' }, { type: 'test', commandRef: 'test', command: { tool: 'npm', args: ['inline'] } }]);
    const before = captureRunPlan(root, spec);
    expect(before.repoCommands).toEqual([{ ...resolved, source: { ...source, profileVersion: 2 } }]);
    expect(vi.mocked(readFileSync).mock.calls.filter(([path]) => path === join(root, '.tekon/repo-profile.yaml'))).toHaveLength(1);
    writeFileSync(join(root, '.tekon/repo-profile.yaml'), JSON.stringify({ version: 2, commands: { build: { tool: 'npm', args: ['run', 'build'], description: 'second' }, test: { notApplicable: true, reason: 'unused' } }, pr: { baseBranch: 'another' }, risks: { highRiskPaths: ['x'] } }));
    expect(captureRunPlan(root, spec).digest).toBe(before.digest);
  });
  it('没有消费ref时不访问损坏的profile/package.json', () => {
    const root = repo();
    writeFileSync(join(root, '.tekon/repo-profile.yaml'), 'SECRET: [');
    writeFileSync(join(root, 'package.json'), 'SECRET: [');
    expect(captureRepoCommands(root, template([{ type: 'build', commandRef: 'build', command: { tool: 'npm', args: [] } }]))).toEqual([]);
    expect(readFileSync).not.toHaveBeenCalled();
  });
  it('自动检测与来源来自同一次package读取，脚本正文和无关script不绑定', () => {
    const root = repo();
    const path = join(root, 'package.json');
    writeFileSync(path, JSON.stringify({ packageManager: 'pnpm@10', scripts: { build: 'first', unrelated: 'a' } }));
    const before = captureRunPlan(root, template());
    expect(before.repoCommands[0]).toEqual({ commandRef: 'build', status: 'resolved', command: { tool: 'pnpm', args: ['build'] }, source: { kind: 'package-json-detection', resolverVersion: 1, path: 'package.json' } });
    expect(vi.mocked(readFileSync).mock.calls.filter(([name]) => name === path)).toHaveLength(1);
    writeFileSync(path, JSON.stringify({ packageManager: 'pnpm@10', scripts: { build: 'second', unrelated: 'b' } }));
    expect(captureRunPlan(root, template()).digest).toBe(before.digest);
    writeFileSync(path, JSON.stringify({ scripts: { build: 'second' } }));
    expect(captureRunPlan(root, template()).digest).not.toBe(before.digest);
    writeFileSync(path, JSON.stringify({ scripts: {} }));
    expect(captureRepoCommands(root, template())[0].status).toBe('missing');
  });
  it('默认缺失和显式不适用为不同事实', () => {
    const root = repo();
    expect(captureRepoCommands(root, template())).toEqual([{ commandRef: 'build', status: 'missing', source: { kind: 'empty-default', resolverVersion: 1 } }]);
    writeFileSync(join(root, '.tekon/repo-profile.yaml'), JSON.stringify({ commands: { build: { notApplicable: true, reason: 'none here' } } }));
    expect(captureRepoCommands(root, template())).toEqual([{ commandRef: 'build', status: 'not-applicable', reason: 'none here', source }]);
  });
  it.each(['profile', 'package'])('非法%s配置返回固定错误且不泄露原文', kind => {
    const root = repo();
    writeFileSync(join(root, kind === 'profile' ? '.tekon/repo-profile.yaml' : 'package.json'), 'SECRET: [');
    expect(() => captureRepoCommands(root, template())).toThrow(/PLAN_CONFIG_INVALID/);
    expect(() => captureRepoCommands(root, template())).not.toThrow(/SECRET/);
  });
  it('package.json不可读取时不能把它当作不存在并绑定missing', () => {
    const root = repo();
    symlinkSync('package.json', join(root, 'package.json'));
    expect(() => captureRepoCommands(root, template())).toThrow(/PLAN_CONFIG_INVALID/);
  });
});

describe('v3纯投影与确认校验', () => {
  it.each([
    { ...resolved, command: { tool: 'pnpm', args: ['build'] } },
    { ...resolved, command: { tool: 'npm', args: ['run', 'other'] } },
    { commandRef: 'build', source, status: 'not-applicable', reason: 'reason' },
    { commandRef: 'build', source, status: 'missing' },
    { ...resolved, source: { ...source, profileVersion: 2 } },
  ])('有效命令/适用性/来源改变使确认失效: %j', entry => {
    const spec = template();
    const confirmed = projectRunPlanV3(spec, {}, [resolved]);
    expect(projectRunPlanV3(spec, {}, [entry as BoundRepoCommand]).digest).not.toBe(confirmed.digest);
    expect(() => buildPreparedRun({ workflowSpec: spec, canonicalPlan: confirmed }, { repoCommands: [entry as BoundRepoCommand] })).toThrow(/PLAN_DIGEST_MISMATCH/);
  });
  it.each([
    [], [resolved, resolved], [resolved, { ...resolved, commandRef: 'test' }],
    [{ ...resolved, commandRef: 'unknown' }], [{ ...resolved, command: { ...resolved.command, env: { secret: 'x' } } }],
    [{ ...resolved, source: { ...source, path: 'package.json' } }], [{ ...resolved, source: { ...source, resolverVersion: 2 } }],
    [{ ...resolved, source: { kind: 'empty-default', resolverVersion: 1 } }],
    [{ commandRef: 'build', status: 'not-applicable', reason: 'impossible', source: { kind: 'package-json-detection', resolverVersion: 1, path: 'package.json' } }],
  ].map(entries => [entries]))('拒绝缺/多/重复/非法绑定: %j', entries => {
    expect(() => projectRunPlanV3(template(), {}, entries as BoundRepoCommand[])).toThrow(/PLAN_/);
  });
  it('纯准备逐份校验bindings/plan/snapshot/digest且深拷贝事实', () => {
    const spec = template(); const entries = structuredClone([resolved]);
    const plan = projectRunPlanV3(spec, {}, entries);
    const prepared = buildPreparedRun({ workflowSpec: spec, canonicalPlan: plan, planSnapshot: canonicalJson(plan), planDigest: plan.digest, repoCommands: entries }, { repoCommands: entries });
    entries[0].source.profileVersion = 9;
    expect(validateRunPlanV3(JSON.parse(prepared.planSnapshot))).toEqual(plan);
    expect(() => buildPreparedRun({ workflowSpec: spec, repoCommands: entries }, { repoCommands: [resolved] })).toThrow(/PLAN_DIGEST_MISMATCH/);
    expect(() => buildPreparedRun({ workflowSpec: spec, canonicalPlan: projectRunPlanV2(spec) }, { repoCommands: [resolved] })).toThrow(/PLAN_DIGEST_MISMATCH/);
  });
});

describe('物化优先级与脱敏行为', () => {
  const cases: Array<[string, Partial<WorkflowGateConfig>, BoundRepoCommand[], string]> = [
    ['inline', { type: 'build', commandRef: 'build', command: { tool: 'npm', args: ['inline'], env: { SECRET: 'value' } } }, [], 'execute-command'],
    ['resolved', { type: 'build', commandRef: 'build' }, [resolved], 'execute-command'],
    ['missing', { type: 'build', commandRef: 'build' }, [{ commandRef: 'build', source, status: 'missing' }], 'missing-command'],
    ['NA', { type: 'build', commandRef: 'build' }, [{ commandRef: 'build', source, status: 'not-applicable', reason: 'private reason' }], 'skip'],
  ];
  it.each(cases)('%s与模板skipReason共存时按真实Gate语义展示', (_name, gate, bindings, behavior) => {
    for (const skipReason of [undefined, 'PRIVATE template reason']) {
      const spec = template([{ ...gate, skipReason }]);
      const plan = projectRunPlanV3(spec, {}, bindings);
      const materialized = runPlanToExecutionPlan(plan, 'run').phases[0].nodes[0].gates[0];
      expect(materialized.gateKey).toBe(templateToPlan(spec, 'run').phases[0].nodes[0].gates[0].gateKey);
      expect(materialized).not.toHaveProperty('commandRef');
      expect(projectRunPlanPreview(plan).gates[0].commandBinding?.behavior).toBe(skipReason ? 'skip' : behavior);
      if (skipReason) expect(materialized.skipReason).toBe(bindings[0]?.status === 'not-applicable' ? 'repo profile commands.build is not applicable: private reason' : skipReason);
    }
  });
  it.each(['resolved', 'missing', 'not-applicable'] as const)('security %s始终忽略skipReason且保留内置扫描', status => {
    const entry: BoundRepoCommand = status === 'resolved' ? resolved : status === 'missing' ? { commandRef: 'build', source, status } : { commandRef: 'build', source, status, reason: 'private reason' };
    const plan = projectRunPlanV3(template([{ type: 'security-scan', commandRef: 'build', skipReason: 'ignored' }]), {}, [entry]);
    expect(projectRunPlanPreview(plan).gates[0].commandBinding?.behavior).toBe(status === 'resolved' ? 'builtin-security-and-command' : 'builtin-security');
  });
  it('非命令Gate不宣称执行外部命令', () => {
    const plan = projectRunPlanV3(template([{ type: 'human', commandRef: 'build' }]), {}, [resolved]);
    expect(projectRunPlanPreview(plan).gates[0].commandBinding?.behavior).toBe('not-command-gate');
  });
  it('仅签名投影包含opaque指纹；秘密、来源对象及临时字段不进入公开/持久事实', () => {
    const plan = projectRunPlanV3(template([{ type: 'build', command: { tool: 'SECRET tool', args: ['SECRET args'], env: { token: 'SECRET env' } }, skipReason: 'SECRET reason' }]), {}, []);
    const signer = { comparisonScope: 'scope', sign: vi.fn((facts: string) => createHmac('sha256', 'private-test-key').update(facts).digest('hex')) };
    const preview = projectRunPlanPreview(plan, signer);
    expect(preview.comparisonScope).toBe('scope');
    expect(preview.gates[0]).toMatchObject({ gateIndex: 0, commandBinding: { status: 'inline', source: 'template', behavior: 'skip', fingerprint: expect.any(String) } });
    expect(JSON.stringify(preview)).not.toContain('SECRET');
    expect(signer.sign).toHaveBeenCalledTimes(1);
    expect(JSON.parse(signer.sign.mock.calls[0][0])).toMatchObject({ purpose: 'tekon.run-plan-gate.v1', nodeId: 'rd', gateIndex: 0 });
    expect(JSON.stringify(plan)).not.toContain('fingerprint');
    expect(JSON.stringify(plan)).not.toContain('comparisonScope');
    expect(projectRunPlanPreview(plan)).not.toHaveProperty('comparisonScope');
    expect(projectRunPlanPreview(plan).gates[0].commandBinding).not.toHaveProperty('fingerprint');
    const changed = structuredClone(plan.template); changed.phases[0].nodes[0].gates[0].skipReason = 'another reason';
    expect(projectRunPlanPreview(projectRunPlanV3(changed, {}, []), signer).gates[0].commandBinding?.fingerprint).not.toBe(preview.gates[0].commandBinding?.fingerprint);
  });
});

describe('历史绑定观察分类', () => {
  const spec = template();
  const v3 = () => projectRunPlanV3(spec, {}, [resolved]);
  const classify = (plan: unknown, hasAdmission = true) => classifyExecutionBinding({ planSnapshot: JSON.stringify(plan), planDigest: (plan as { digest?: string }).digest, kind: 'workflow', hasAdmission });
  it('有效v3/v2分别标记已绑定/历史，未知版本不视为历史', () => {
    expect(classify(v3())).toBe('frozen');
    expect(classify(projectRunPlanV2(spec))).toBe('legacy-unbound');
    expect(classify({ ...v3(), digestVersion: 99 })).toBe('unknown');
  });
  it('缺损新快照不可伪装已冻结或历史', () => {
    const broken = { ...v3(), repoCommands: [] }; broken.digest = computeRunPlanDigest(broken);
    expect(classify(broken)).toBe('invalid');
    expect(classify({ ...v3(), digest: 'wrong' })).toBe('invalid');
    expect(classifyExecutionBinding({ planSnapshot: 'SECRET: [', planDigest: 'wrong', kind: 'workflow', hasAdmission: true })).toBe('invalid');
    expect(classifyExecutionBinding({ planSnapshot: null, planDigest: null, kind: 'workflow', hasAdmission: true })).toBe('invalid');
    expect(classifyExecutionBinding({ planSnapshot: null, planDigest: null, kind: 'workflow', hasAdmission: false })).toBe('legacy-unbound');
  });
  it('真实v1/无snapshot只在无admission时降级，版本字段和单边缺失损坏返回invalid', () => {
    const legacy = { agent: 'codex', gates: [], roleChain: ['rd'] };
    const digest = computeRunPlanDigestV1(legacy);
    const input = { planSnapshot: canonicalJson(legacy), planDigest: digest, kind: 'workflow' as const, hasAdmission: false };
    expect(classifyExecutionBinding(input)).toBe('legacy-unbound');
    expect(classifyExecutionBinding({ ...input, hasAdmission: true })).toBe('invalid');
    expect(classifyExecutionBinding({ ...input, planDigest: 'wrong' })).toBe('invalid');
    expect(classifyExecutionBinding({ ...input, planSnapshot: null })).toBe('invalid');
    expect(classifyExecutionBinding({ ...input, planDigest: null })).toBe('invalid');
    for (const digestVersion of [null, '3', 0, -1, 3.5]) expect(classify({ ...v3(), digestVersion })).toBe('invalid');
    expect(classifyExecutionBinding({ planSnapshot: canonicalJson(v3()), planDigest: v3().digest, kind: 'goal', hasAdmission: true })).toBe('invalid');
  });
});
