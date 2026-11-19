import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizeExecutableTemplate,
  parseWorkflowTemplate,
  validateWorkflowTemplateFile,
  loadBuiltInWorkflowTemplate,
  type WorkflowTemplate,
} from '../../src/workflow/template.js';
import {
  projectRunPlanV2,
  projectRunPlanV3,
  validateRunPlanV2,
  validateRunPlanV3,
} from '../../src/workflow/run-plan.js';
import type { BoundRepoCommand } from '../../src/workflow/repo-command-binding.js';

// PD-21：delivery 声明的 schema 与双收口一致性校验（M2/M3）。
// 最小合法模板：单节点带一个 build 门禁，供声明引用。
const baseYaml = (delivery: string): string => `
id: tpl-under-test
name: Under Test
version: 1
phases:
  - id: impl
    nodes:
      - id: rd-1
        role: rd
        outputs:
          - code-changes
        gates:
          - type: build
            command:
              tool: pnpm
              args: ["build"]
          - type: schema
            artifactType: code-changes
${delivery}
`;

describe('PD-21 delivery declaration validation', () => {
  // TS-05：本 describe 内 mkdtemp 的临时目录统一登记清理，不向系统 tmp 泄漏。
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('保留合法声明并透传到归一化模板（不丢字段、不注入默认）', () => {
    const tpl = parseWorkflowTemplate(
      baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: [build]
    governanceGates: []
    qaReleaseSignoff: true
`).replace(
        '          - type: schema\n            artifactType: code-changes',
        '          - type: schema\n            artifactType: code-changes\n' +
          '          - type: qa-signoff',
      ),
    );
    expect(tpl.delivery).toEqual({
      deliverable: true,
      requirements: {
        commandGates: ['build'],
        governanceGates: [],
        qaReleaseSignoff: true,
      },
    });
  });

  it('无 delivery 字段时归一化结果不含该键（纯 optional，无默认对象）', () => {
    const tpl = parseWorkflowTemplate(baseYaml(''));
    expect(tpl).not.toHaveProperty('delivery');
  });

  it('空数组与缺省同效，可正常通过校验', () => {
    const tpl = parseWorkflowTemplate(
      baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: []
    governanceGates: []
`),
    );
    expect(tpl.delivery?.deliverable).toBe(true);
  });

  it('收口一：commandGates 类别越界（含 human）被 schema 拒绝并带 INVALID_WORKFLOW_TEMPLATE 前缀', () => {
    expect(() =>
      parseWorkflowTemplate(
        baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: [human]
`),
      ),
    ).toThrow(/INVALID_WORKFLOW_TEMPLATE/);
  });

  it('收口一：governanceGates 类别越界（含 build）被 schema 拒绝并带 INVALID_WORKFLOW_TEMPLATE 前缀', () => {
    expect(() =>
      parseWorkflowTemplate(
        baseYaml(`
delivery:
  deliverable: true
  requirements:
    governanceGates: [build]
`),
      ),
    ).toThrow(/INVALID_WORKFLOW_TEMPLATE/);
  });

  it('收口一：validate 文件探针把枚举越界翻译为带「模板结构不合法」的单行中文错误', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-delivery-enum-'));
    tempDirs.push(dir);
    const file = join(dir, 'bad-enum.yaml');
    writeFileSync(
      file,
      baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: [human]
`),
      'utf8',
    );
    const result = validateWorkflowTemplateFile(file);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('模板结构不合法');
      expect(result.error).toContain('delivery');
      expect(result.error).not.toContain('ZodError');
      expect(result.error.split('\n')).toHaveLength(1);
    }
  });

  it('CD-01：delivery 与非 delivery 字段同时非法时，两类错误都保留在同一条消息中', () => {
    // 顶层未知键（strict 拒绝）+ delivery 枚举越界同时存在。
    const broken = `
id: tpl-mixed-errors
name: Mixed
version: 1
unknownTopLevel: x
phases:
  - id: impl
    nodes:
      - id: rd-1
        role: rd
        outputs:
          - code-changes
        gates:
          - type: build
          - type: schema
            artifactType: code-changes
delivery:
  deliverable: true
  requirements:
    commandGates: [human]
`;
    expect(() => parseWorkflowTemplate(broken)).toThrow(
      /INVALID_WORKFLOW_TEMPLATE/,
    );
    try {
      parseWorkflowTemplate(broken);
      throw new Error('expected throw');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // delivery 问题与非 delivery 的未知键问题都在，作者无需多轮修复。
      expect(message).toContain('delivery');
      expect(message).toContain('unknownTopLevel');
    }
  });

  it('CD-02：布尔要求为 true 但模板无对应门禁时，validate 期即拒绝', () => {
    // baseYaml 模板只有 build/schema 门，没有 qa-signoff/security-scan/ac-evidence。
    expect(() =>
      parseWorkflowTemplate(
        baseYaml(`
delivery:
  deliverable: true
  requirements:
    qaReleaseSignoff: true
`),
      ),
    ).toThrow(/INVALID_WORKFLOW_TEMPLATE/);
    expect(() =>
      parseWorkflowTemplate(
        baseYaml(`
delivery:
  deliverable: true
  requirements:
    securityScan: true
`),
      ),
    ).toThrow(/INVALID_WORKFLOW_TEMPLATE/);
    expect(() =>
      parseWorkflowTemplate(
        baseYaml(`
delivery:
  deliverable: true
  requirements:
    acceptanceEvidence: true
`),
      ),
    ).toThrow(/INVALID_WORKFLOW_TEMPLATE/);
  });

  it('CD-02：布尔要求为 false/缺省时不要求对应门禁存在', () => {
    const tpl = parseWorkflowTemplate(
      baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: [build]
    qaReleaseSignoff: false
`),
    );
    expect(tpl.delivery?.requirements?.qaReleaseSignoff).toBe(false);
  });

  it('收口一：声明模板中不存在的门禁类型报 INVALID_WORKFLOW_TEMPLATE', () => {
    // baseYaml 只有 build/schema，没有 test。
    expect(() =>
      parseWorkflowTemplate(
        baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: [build, test]
`),
      ),
    ).toThrow(/INVALID_WORKFLOW_TEMPLATE/);
  });

  it('收口一：拒绝数组内重复门禁类型', () => {
    expect(() =>
      parseWorkflowTemplate(
        baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: [build, build]
`),
      ),
    ).toThrow(/INVALID_WORKFLOW_TEMPLATE/);
  });

  it('收口一：deliverable:false 却带 requirements 的矛盾声明被拒', () => {
    expect(() =>
      parseWorkflowTemplate(
        baseYaml(`
delivery:
  deliverable: false
  requirements:
    securityScan: true
`),
      ),
    ).toThrow(/INVALID_WORKFLOW_TEMPLATE/);
  });

  it('收口二：normalizeExecutableTemplate 同样拦截不存在的声明门（程序化构造纵深防御）', () => {
    const valid = parseWorkflowTemplate(
      baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: [build]
`),
    );
    const tampered = {
      ...valid,
      delivery: {
        deliverable: true,
        requirements: { commandGates: ['test'] },
      },
    };
    expect(() => normalizeExecutableTemplate(tampered)).toThrow(
      /INVALID_WORKFLOW_TEMPLATE/,
    );
  });

  it('收口二：枚举越界经 normalizeExecutableTemplate 同样报 INVALID_WORKFLOW_TEMPLATE', () => {
    const valid = parseWorkflowTemplate(
      baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: [build]
`),
    );
    const tampered = {
      ...valid,
      delivery: {
        deliverable: true,
        requirements: { commandGates: ['human'] },
      },
    };
    expect(() => normalizeExecutableTemplate(tampered)).toThrow(
      /INVALID_WORKFLOW_TEMPLATE/,
    );
  });

  it('收口二：合法声明经 normalizeExecutableTemplate 不抛错且保留', () => {
    const valid = parseWorkflowTemplate(
      baseYaml(`
delivery:
  deliverable: true
  requirements:
    commandGates: [build]
`),
    );
    const again = normalizeExecutableTemplate(valid);
    expect(again.delivery?.requirements?.commandGates).toEqual(['build']);
  });
});

// 复刻 run-plan-integrity 的空仓库事实：commandRef 全部记为 missing，
// 让 V3 投影的 repoCommands 自洽。
function emptyRepoFacts(template: WorkflowTemplate): BoundRepoCommand[] {
  const refs = [
    ...new Set(
      template.phases.flatMap((phase) =>
        phase.nodes.flatMap((node) =>
          node.gates.flatMap((gate) =>
            gate.commandRef && !gate.command ? [gate.commandRef] : [],
          ),
        ),
      ),
    ),
  ].sort();
  return refs.map((commandRef) => ({
    commandRef,
    status: 'missing',
    source: { kind: 'empty-default', resolverVersion: 1 },
  }));
}

describe('PD-21 delivery 声明与历史快照兼容（M3）', () => {
  it('升级前冻结的无 delivery 键 V3 快照重投影不抛 PLAN_DIGEST_MISMATCH', () => {
    // 模拟升级前冻结：取当前 bugfix 模板（现含 delivery），剥离该键。
    const legacy = loadBuiltInWorkflowTemplate('bugfix');
    delete legacy.delivery;
    expect(legacy).not.toHaveProperty('delivery');

    const snapshot = projectRunPlanV3(
      legacy,
      { agent: 'codex' },
      emptyRepoFacts(legacy),
    );
    expect(() => validateRunPlanV3(snapshot)).not.toThrow();
    expect(validateRunPlanV3(snapshot).template).not.toHaveProperty('delivery');
  });

  it('升级前冻结的无 delivery 键 V2 快照同样通过校验', () => {
    const legacy = loadBuiltInWorkflowTemplate('bugfix');
    delete legacy.delivery;
    const snapshot = projectRunPlanV2(legacy, { agent: 'codex' });
    expect(() => validateRunPlanV2(snapshot)).not.toThrow();
  });

  it('新增 delivery 声明改变 digest，旧确认不能冒充新计划（演进可检测）', () => {
    const legacy = loadBuiltInWorkflowTemplate('bugfix');
    delete legacy.delivery;
    const oldDigest = projectRunPlanV3(
      legacy,
      { agent: 'codex' },
      emptyRepoFacts(legacy),
    ).digest;

    const current = loadBuiltInWorkflowTemplate('bugfix');
    expect(current.delivery).toBeDefined();
    const newDigest = projectRunPlanV3(
      current,
      { agent: 'codex' },
      emptyRepoFacts(current),
    ).digest;
    expect(newDigest).not.toBe(oldDigest);
  });

  it('带 delivery 的新快照自洽并通过 V3 校验，声明随模板冻结', () => {
    const template = loadBuiltInWorkflowTemplate('standard-delivery');
    const snapshot = projectRunPlanV3(
      template,
      { agent: 'codex' },
      emptyRepoFacts(template),
    );
    expect(() => validateRunPlanV3(snapshot)).not.toThrow();
    expect(
      validateRunPlanV3(snapshot).template.delivery?.requirements?.commandGates,
    ).toEqual(['build', 'lint', 'test']);
  });
});
