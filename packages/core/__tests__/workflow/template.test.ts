import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listWorkflowCatalog,
  loadWorkflowTemplate,
  parseWorkflowTemplate,
  validateWorkflowTemplateFile,
} from '../../src/workflow/template.js';

describe('workflow template parser', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('parses a typed workflow template with phases, nodes, artifact refs, gates, and retry policy', () => {
    const template = parseWorkflowTemplate(`
id: standard-feature
name: Standard Feature
retry:
  maxRetries: 2
  onExhausted: pause
phases:
  - id: discovery
    name: Discovery
    nodes:
      - id: pm-demand
        role: pm
        outputs:
          - demand-card
  - id: implementation
    name: Implementation
    nodes:
      - id: rd-code
        role: rd
        dependsOn:
          - pm-demand
        inputs:
          - from: pm-demand
            type: demand-card
        outputs:
          - code-changes
        gates:
          - type: build
            gateKey: build-main
            command:
              tool: pnpm
              args: ["build"]
          - type: lint
            command:
              tool: pnpm
              args: ["lint"]
          - type: schema
            artifactType: code-changes
  - id: validation
    name: Validation
    nodes:
      - id: qa-test
        role: qa
        dependsOn:
          - rd-code
        outputs:
          - test-report
        gates:
          - type: e2e-pass
  - id: review
    name: Review
    nodes:
      - id: reviewer-check
        role: reviewer
        dependsOn:
          - qa-test
        outputs:
          - review-report
  - id: delivery
    name: Delivery
    nodes:
      - id: pmo-package
        role: pmo
        dependsOn:
          - reviewer-check
        outputs:
          - delivery-package
`);

    expect(template).toMatchObject({
      id: 'standard-feature',
      retryPolicy: { maxRetries: 2, onExhausted: 'pause' },
    });
    expect(template.phases.map((phase) => phase.id)).toEqual([
      'discovery',
      'implementation',
      'validation',
      'review',
      'delivery',
    ]);
    expect(template.phases[1]?.nodes[0]).toMatchObject({
      id: 'rd-code',
      role: 'rd',
      dependsOn: ['pm-demand'],
      inputs: [
        {
          id: 'demand-card',
          fromNodeId: 'pm-demand',
          type: 'demand-card',
        },
      ],
      outputs: [{ id: 'code-changes', type: 'code-changes' }],
      gates: [
        { type: 'build', gateKey: 'build-main' },
        { type: 'lint' },
        { type: 'schema', artifactType: 'code-changes' },
      ],
    });
  });

  it('loads built-in standard-feature and bugfix templates from disk', () => {
    for (const name of [
      'standard-feature',
      'bugfix',
      'test-improvement',
      'docs-update',
      'plan-only',
      'standard-delivery',
    ]) {
      expect(loadWorkflowTemplate({ name })).toMatchObject({ id: name });
    }
  });

  it('loads standard-delivery with scoped review checkpoints and supported gates', () => {
    const template = loadWorkflowTemplate({ name: 'standard-delivery' });
    const nodes = template.phases.flatMap((phase) => phase.nodes);
    const nodeIds = nodes.map((node) => node.id);

    expect(nodeIds).toEqual([
      'pm-demand-card',
      'pm-demand-review',
      'pm-requirement-intent-review',
      'rd-requirement-interface-review',
      'qa-requirement-interface-review',
      'rd-implementation-plan',
      'rd-technical-review',
      'qa-test-plan',
      'qa-test-plan-review',
      'pm-test-plan-intent-review',
      'rd-code-change',
      'reviewer-change-review',
      'qa-validation',
      'qa-release-signoff',
      'qa-release-signoff-review',
      'pmo-checkpoint',
    ]);

    expect(nodes.find((node) => node.id === 'pm-demand-review')).toMatchObject({
      role: 'pm',
      gates: expect.arrayContaining([
        expect.objectContaining({
          type: 'schema',
          artifactType: 'demand-review',
        }),
        expect.objectContaining({
          type: 'role-scope',
          artifactType: 'demand-review',
        }),
      ]),
    });
    expect(
      nodes.find((node) => node.id === 'pm-requirement-intent-review'),
    ).toMatchObject({ role: 'pm' });
    expect(
      nodes.find((node) => node.id === 'rd-requirement-interface-review'),
    ).toMatchObject({ role: 'rd' });
    expect(
      nodes.find((node) => node.id === 'qa-requirement-interface-review'),
    ).toMatchObject({ role: 'qa' });
    expect(
      nodes.find((node) => node.id === 'rd-technical-review'),
    ).toMatchObject({ role: 'rd' });
    expect(
      nodes.find((node) => node.id === 'qa-test-plan-review'),
    ).toMatchObject({ role: 'qa' });
    expect(
      nodes.find((node) => node.id === 'reviewer-change-review'),
    ).toMatchObject({ role: 'reviewer' });
    expect(
      nodes.find((node) => node.id === 'qa-release-signoff'),
    ).toMatchObject({ role: 'qa' });
    expect(
      nodes.find((node) => node.id === 'qa-release-signoff-review'),
    ).toMatchObject({ role: 'qa' });
    expect(nodes.find((node) => node.id === 'pmo-checkpoint')).toMatchObject({
      role: 'pmo',
    });

    const gateTypes = new Set(
      nodes.flatMap((node) => node.gates.map((gate) => gate.type)),
    );
    expect(gateTypes).toEqual(
      new Set([
        'ac-evidence',
        'build',
        'independent-review',
        'lint',
        'process-completeness',
        'qa-signoff',
        'role-scope',
        'schema',
        'security-scan',
        'test',
      ]),
    );
    expect(nodes.find((node) => node.id === 'rd-code-change')).toMatchObject({
      gates: expect.arrayContaining([
        expect.objectContaining({ type: 'build', commandRef: 'build' }),
        expect.objectContaining({ type: 'lint', commandRef: 'lint' }),
        expect.objectContaining({
          type: 'security-scan',
          commandRef: 'security',
        }),
      ]),
    });
    expect(nodes.find((node) => node.id === 'qa-validation')).toMatchObject({
      gates: expect.arrayContaining([
        expect.objectContaining({ type: 'test', commandRef: 'test' }),
      ]),
    });
  });

  // PD-18：human gate 可声明返工目标节点；驳回恢复时据此触发返工，不靠启发式。
  it('parses reworkTargetNodeId on a human gate and rejects unknown or disconnected targets', () => {
    const valid = parseWorkflowTemplate(`
id: human-rework
name: Human Rework
phases:
  - id: impl
    nodes:
      - id: rd-code
        role: rd
        outputs: [code-changes]
  - id: review
    dependsOn: [impl]
    nodes:
      - id: reviewer-check
        role: reviewer
        inputs:
          - from: rd-code
            type: code-changes
        outputs: [review-report]
        gates:
          - type: human
            requiresHumanApproval: true
            reworkTargetNodeId: rd-code
`);
    const humanGate = valid.phases[1]!.nodes[0]!.gates[0]!;
    expect(humanGate).toMatchObject({
      type: 'human',
      reworkTargetNodeId: 'rd-code',
    });

    // 目标节点不存在。
    expect(() =>
      parseWorkflowTemplate(`
id: human-rework-missing
name: Human Rework
phases:
  - id: review
    nodes:
      - id: reviewer-check
        role: reviewer
        outputs: [review-report]
        gates:
          - type: human
            requiresHumanApproval: true
            reworkTargetNodeId: rd-ghost
`),
    ).toThrow(/reworkTargetNodeId/u);

    // 目标节点不是该评审节点的上游（无 input/dependency 连通）。
    expect(() =>
      parseWorkflowTemplate(`
id: human-rework-disconnected
name: Human Rework
phases:
  - id: impl
    nodes:
      - id: rd-a
        role: rd
        outputs: [code-changes]
      - id: rd-b
        role: pm
        outputs: [prd]
  - id: review
    dependsOn: [impl]
    nodes:
      - id: reviewer-check
        role: reviewer
        inputs:
          - from: rd-a
            type: code-changes
        outputs: [review-report]
        gates:
          - type: human
            requiresHumanApproval: true
            reworkTargetNodeId: rd-b
`),
    ).toThrow(/reworkTargetNodeId|upstream|连通/u);
  });

  it('rejects invalid artifact dependencies and conflicting outputs', () => {
    expect(() =>
      parseWorkflowTemplate(`
id: invalid-artifact-ref
phases:
  - id: code
    nodes:
      - id: rd-code
        role: rd
        dependsOn: [missing-node]
        inputs:
          - from: missing-node
            type: demand-card
        outputs: [code-changes]
        gates:
          - type: build
          - type: lint
  - id: validation
    nodes:
      - id: qa-test
        role: qa
  - id: review
    nodes:
      - id: reviewer-check
        role: reviewer
`),
    ).toThrow(/unknown dependency/u);

    expect(() =>
      parseWorkflowTemplate(`
id: conflict
phases:
  - id: impl
    nodes:
      - id: rd-a
        role: rd
        outputs: [code-changes]
        gates:
          - type: build
          - type: lint
      - id: rd-b
        role: rd
        outputs: [code-changes]
        gates:
          - type: build
          - type: lint
  - id: validation
    nodes:
      - id: qa-test
        role: qa
  - id: review
    nodes:
      - id: reviewer-check
        role: reviewer
`),
    ).toThrow(/conflicting output/u);
  });

  // PD-06 子项 4：reviewer 和 Gate 是可选产品行为，治理由模板自身内容表达。
  // governance 字段保留解析兼容但不再影响校验。
  it('accepts a reviewer-less template without any governance override', () => {
    const minimal = parseWorkflowTemplate(`
id: minimal-task
name: Minimal Task
phases:
  - id: goal
    name: Goal
    nodes:
      - id: goal-execute
        role: goal
`);
    expect(minimal.id).toBe('minimal-task');
    expect(minimal.phases).toHaveLength(1);
    expect(minimal.phases[0].nodes[0]).toMatchObject({ role: 'goal', gates: [] });
  });

  it('keeps accepting the legacy governance field as a no-op for old templates', () => {
    const goal = parseWorkflowTemplate(`
id: goal
name: Goal
governance: none
phases:
  - id: goal
    name: Goal
    nodes:
      - id: goal-execute
        role: goal
`);
    expect(goal.id).toBe('goal');

    const standard = parseWorkflowTemplate(`
id: standard-no-reviewer
governance: standard
phases:
  - id: code
    nodes:
      - id: rd-code
        role: rd
`);
    expect(standard.phases[0].nodes[0].role).toBe('rd');
  });

  it('allows code-producing nodes without build and lint gates', () => {
    const template = parseWorkflowTemplate(`
id: light-code
phases:
  - id: code
    nodes:
      - id: rd-code
        role: rd
        outputs: [code-changes]
`);
    expect(template.phases[0].nodes[0].outputs).toEqual([
      { id: 'code-changes', type: 'code-changes' },
    ]);
    expect(template.phases[0].nodes[0].gates).toEqual([]);
  });

  it('loads the built-in goal template from disk', () => {
    const template = loadWorkflowTemplate({ name: 'goal' });
    expect(template.id).toBe('goal');
    expect(template.phases[0].nodes[0].role).toBe('goal');
  });

  it('rejects duplicate effective gate keys within the same node', () => {
    expect(() =>
      parseWorkflowTemplate(`
id: duplicate-gate-key
phases:
  - id: implementation
    nodes:
      - id: rd-code
        role: rd
        outputs: [code-changes]
        gates:
          - type: build
            gateKey: validate
          - type: lint
            gateKey: validate
  - id: review
    nodes:
      - id: reviewer-check
        role: reviewer
        dependsOn: [rd-code]
`),
    ).toThrow(/duplicate gateKey "validate" in node "rd-code"/u);
  });

  it('rejects workflow paths outside the configured workflows directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-workflows-'));
    tempDirs.push(root);
    const workflowsDir = join(root, 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    writeFileSync(join(root, 'evil.yaml'), 'id: evil\nphases: []\n', 'utf8');

    expect(() =>
      loadWorkflowTemplate({ name: '../evil', workflowsDir }),
    ).toThrow(/invalid workflow template name/u);
  });

  it('lists built-in workflow template catalog entries with id matching filename', () => {
    const catalog = listWorkflowCatalog();
    const ids = catalog.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'bugfix',
        'docs-update',
        'goal',
        'plan-only',
        'standard-delivery',
        'standard-feature',
        'test-improvement',
      ]),
    );

    const goalEntry = catalog.find((entry) => entry.id === 'goal');
    expect(goalEntry).toBeDefined();
    expect(goalEntry?.builtin).toBe(true);
    expect(goalEntry?.name).toBe('Goal');

    const bugfixEntry = catalog.find((entry) => entry.id === 'bugfix');
    expect(bugfixEntry).toBeDefined();
    expect(bugfixEntry?.builtin).toBe(true);
    expect(bugfixEntry?.name).toBe('Bugfix');
  });

  it('merges project workflows, overrides same-name built-ins, and derives id strictly from filename', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-project-workflows-'));
    tempDirs.push(root);
    const projectWorkflowsDir = join(root, '.tekon', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });

    // Custom workflow with differing internal YAML id
    writeFileSync(
      join(projectWorkflowsDir, 'custom-flow.yaml'),
      `id: internal-different-id\nname: Custom Project Flow\ngovernance: none\nphases:\n  - id: p1\n    nodes:\n      - id: n1\n        role: goal\n`,
      'utf8',
    );

    // Override built-in bugfix
    writeFileSync(
      join(projectWorkflowsDir, 'bugfix.yaml'),
      `id: internal-bugfix-override\nname: Overridden Bugfix\ngovernance: none\nphases:\n  - id: p1\n    nodes:\n      - id: n1\n        role: goal\n`,
      'utf8',
    );

    // Custom workflow using .yml extension
    writeFileSync(
      join(projectWorkflowsDir, 'yml-flow.yml'),
      `id: internal-yml-id\nname: YML Project Flow\ngovernance: none\nphases:\n  - id: p1\n    nodes:\n      - id: n1\n        role: goal\n`,
      'utf8',
    );

    // Override built-in docs-update using .yml extension
    writeFileSync(
      join(projectWorkflowsDir, 'docs-update.yml'),
      `id: internal-docs-override\nname: Overridden Docs Update\ngovernance: none\nphases:\n  - id: p1\n    nodes:\n      - id: n1\n        role: goal\n`,
      'utf8',
    );

    const catalog = listWorkflowCatalog({ projectWorkflowsDir });
    const customEntry = catalog.find((entry) => entry.id === 'custom-flow');
    expect(customEntry).toBeDefined();
    expect(customEntry).toMatchObject({
      id: 'custom-flow',
      name: 'Custom Project Flow',
      builtin: false,
      path: join(projectWorkflowsDir, 'custom-flow.yaml'),
    });

    const ymlEntry = catalog.find((entry) => entry.id === 'yml-flow');
    expect(ymlEntry).toBeDefined();
    expect(ymlEntry).toMatchObject({
      id: 'yml-flow',
      name: 'YML Project Flow',
      builtin: false,
      path: join(projectWorkflowsDir, 'yml-flow.yml'),
    });

    const docsEntry = catalog.find((entry) => entry.id === 'docs-update');
    expect(docsEntry).toBeDefined();
    expect(docsEntry).toMatchObject({
      id: 'docs-update',
      name: 'Overridden Docs Update',
      builtin: false,
      path: join(projectWorkflowsDir, 'docs-update.yml'),
    });

    const bugfixEntry = catalog.find((entry) => entry.id === 'bugfix');
    expect(bugfixEntry).toBeDefined();
    expect(bugfixEntry).toMatchObject({
      id: 'bugfix',
      name: 'Overridden Bugfix',
      builtin: false,
      path: join(projectWorkflowsDir, 'bugfix.yaml'),
    });

    const stdEntry = catalog.find((entry) => entry.id === 'standard-delivery');
    expect(stdEntry).toBeDefined();
    expect(stdEntry?.builtin).toBe(true);
  });
});

describe('PD-07 workflow template validation probe', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const validYaml = `
id: minimal
name: Minimal
version: 1
phases:
  - id: dev
    name: Dev
    dependsOn: []
    nodes:
      - id: n1
        role: rd
        inputs: []
        outputs: []
        gates: []
        dependsOn: []
`;

  it('returns a valid result for a parseable template file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-valid-'));
    tempDirs.push(dir);
    const file = join(dir, 'minimal.yaml');
    writeFileSync(file, validYaml);
    const result = validateWorkflowTemplateFile(file);
    expect(result.valid).toBe(true);
    if (result.valid) expect(result.template.id).toBe('minimal');
  });

  it('returns an invalid result with a readable error instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-invalid-'));
    tempDirs.push(dir);
    const file = join(dir, 'broken.yaml');
    writeFileSync(file, 'id: broken\nphases: not-a-list\n');
    const result = validateWorkflowTemplateFile(file);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      // CD-20：必须是「字段路径: 原因」的可读单行，而不是裸 zod JSON。
      expect(result.error).toContain('phases');
      expect(result.error).not.toContain('"code"');
      expect(result.error).not.toContain('"expected"');
      expect(result.error).not.toContain('ZodError');
      expect(result.error.split('\n')).toHaveLength(1);
    }
  });

  it('reports a missing file as a readable validation failure rather than throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-missing-'));
    tempDirs.push(dir);
    const result = validateWorkflowTemplateFile(join(dir, 'absent.yaml'));
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('absent.yaml');
      expect(result.error).not.toContain('ZodError');
    }
  });

  it('translates common zod issues into single-line Chinese reasons (CD-20)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-zh-'));
    tempDirs.push(dir);
    const probe = (name: string, content: string): string => {
      const file = join(dir, name);
      writeFileSync(file, content);
      const result = validateWorkflowTemplateFile(file);
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error('expected invalid template');
      return result.error;
    };

    const typeError = probe('type.yaml', 'id: t\nphases: nope\n');
    expect(typeError).toContain('phases');
    expect(typeError).toMatch(/类型错误/u);
    expect(typeError).not.toMatch(/Invalid input|expected array/u);
    // 两阶段解析可能不携带 received，兜底也必须是中文完整句而非 undefined。
    expect(typeError).not.toContain('undefined');
    expect(typeError).toMatch(/当前值缺失或类型不符/u);
    expect(typeError.split('\n')).toHaveLength(1);

    const missingError = probe('missing.yaml', 'id: t\nname: T\nversion: 1\n');
    expect(missingError).toContain('phases');
    expect(missingError).toMatch(/类型错误|必填/u);

    const unknownKeyError = probe(
      'unknown.yaml',
      'id: t\nname: T\nversion: 1\nphases: []\nbogus: 1\n',
    );
    expect(unknownKeyError).toMatch(/未知字段/u);
    expect(unknownKeyError).toContain('bogus');
  });

  it('collapses multi-line YAML syntax errors into one readable line', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-yaml-'));
    tempDirs.push(dir);
    const file = join(dir, 'syntax.yaml');
    writeFileSync(file, 'id: syntax\nphases:\n  - id: dev\n   nodes: []\n');
    const result = validateWorkflowTemplateFile(file);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toMatch(/YAML/u);
      expect(result.error.split('\n')).toHaveLength(1);
      expect(result.error).not.toContain('YAMLParseError');
    }
  });

  it('translates enum and union zod issues plus semantic errors into Chinese (CD-20)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-semantic-'));
    tempDirs.push(dir);
    const probe = (name: string, content: string): string => {
      const file = join(dir, name);
      writeFileSync(file, content);
      const result = validateWorkflowTemplateFile(file);
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error('expected invalid template');
      return result.error;
    };

    const nodeBlock = (inner: string): string =>
      `id: t\nname: T\nversion: 1\nphases:\n  - id: p\n    name: P\n    dependsOn: []\n    nodes:\n      - id: n1\n        role: rd\n        inputs: []\n${inner}\n        dependsOn: []\n`;

    // 枚举值错误（zod v4 code=invalid_value，只携带允许 values 列表，
    // 不含错误输入值；断言落在字段路径与可选值提示上）。
    const enumError = probe(
      'enum.yaml',
      nodeBlock(
        '        outputs: []\n        gates:\n          - type: magic-gate',
      ),
    );
    expect(enumError).toMatch(/取值非法|可选值/u);
    expect(enumError).toContain('gates.0.type');
    expect(enumError).toContain('build');
    expect(enumError).not.toMatch(/Invalid option/u);
    expect(enumError.split('\n')).toHaveLength(1);

    // 联合类型错误（zod v4 code=invalid_union）。
    const unionError = probe(
      'union.yaml',
      nodeBlock('        outputs: [123]\n        gates: []'),
    );
    expect(unionError).toMatch(/类型|结构/u);
    expect(unionError).not.toMatch(/Invalid input/u);

    // zod 通过后的语义校验错误（normalize 层英文 throw）。
    const phaseNode =
      '    nodes:\n      - id: n1\n        role: rd\n        inputs: []\n        outputs: []\n        gates: []\n        dependsOn: []\n';
    const duplicatePhase = `id: t\nname: T\nversion: 1\nphases:\n  - id: same\n    name: A\n    dependsOn: []\n${phaseNode}  - id: same\n    name: B\n    dependsOn: []\n${phaseNode}`;
    const dupError = probe('dup.yaml', duplicatePhase);
    expect(dupError).toMatch(/重复/u);
    expect(dupError).toContain('same');
    expect(dupError).not.toMatch(/Duplicate/u);

    const unknownDep = `id: t\nname: T\nversion: 1\nphases:\n  - id: p\n    name: P\n    dependsOn: []\n    nodes:\n      - id: n1\n        role: rd\n        inputs: []\n        outputs: []\n        gates: []\n        dependsOn: [ghost]\n`;
    const depError = probe('dep.yaml', unknownDep);
    expect(depError).toMatch(/未知依赖/u);
    expect(depError).toContain('ghost');
    expect(depError).not.toMatch(/unknown dependency/u);
  });

  it('translates custom superRefine and identifier format issues into Chinese', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-custom-'));
    tempDirs.push(dir);
    const probe = (name: string, content: string): string => {
      const file = join(dir, name);
      writeFileSync(file, content);
      const result = validateWorkflowTemplateFile(file);
      expect(result.valid).toBe(false);
      if (result.valid) throw new Error('expected invalid template');
      return result.error;
    };
    const nodeWith = (role: string, gate: string): string =>
      `id: t\nname: T\nversion: 1\nphases:\n  - id: p\n    name: P\n    dependsOn: []\n    nodes:\n      - id: n\n        role: ${role}\n        inputs: []\n        outputs: []\n        gates:\n${gate}\n        dependsOn: []\n`;

    // invalid_format：identifier kebab-case 校验。
    const identifierError = probe(
      'identifier.yaml',
      nodeWith('Bad Role', '          []'),
    );
    expect(identifierError).toMatch(/标识符|kebab/u);
    expect(identifierError).not.toMatch(/identifier must be/u);

    // custom：schema 门禁缺 artifactType。
    const schemaError = probe(
      'schema.yaml',
      nodeWith('rd', '          - type: schema'),
    );
    expect(schemaError).toMatch(/schema|artifactType|产物/u);
    expect(schemaError).not.toMatch(/requires artifactType/u);

    // custom：human 门禁显式关闭人工审批。
    const humanError = probe(
      'human.yaml',
      nodeWith(
        'rd',
        '          - type: human\n            requiresHumanApproval: false',
      ),
    );
    expect(humanError).toMatch(/human|人工审批/u);
    expect(humanError).not.toMatch(/requires human approval/u);

    // custom：非 human 门禁挂 reworkTargetNodeId。
    const reworkError = probe(
      'rework.yaml',
      nodeWith(
        'rd',
        '          - type: build\n            reworkTargetNodeId: n',
      ),
    );
    expect(reworkError).toMatch(/reworkTargetNodeId|human/u);
    expect(reworkError).not.toMatch(/is only valid on human gates/u);
  });

  it('accepts symlinked template files so shared templates stay loadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-symlink-'));
    tempDirs.push(dir);
    const target = join(dir, 'target.yaml');
    const link = join(dir, 'linked.yaml');
    writeFileSync(target, validYaml);
    symlinkSync(target, link);

    const catalog = listWorkflowCatalog({ projectWorkflowsDir: dir });
    const ids = catalog.map((entry) => entry.id);
    expect(ids).toContain('linked');

    const result = validateWorkflowTemplateFile(link);
    expect(result.valid).toBe(true);
  });

  it('refuses symlinks escaping the template directory without reading target contents', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-tpl-escape-'));
    tempDirs.push(root);
    const workflowsDir = join(root, '.tekon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });

    // 仓库外的「凭据」文件：格式故意非法，若被读取解析，片段会进入错误输出。
    const outside = join(root, 'secret.ini');
    writeFileSync(
      outside,
      'SECRET_TOKEN: [unclosed\nsecond_line_pw: hunter2\n',
    );
    const escapeLink = join(workflowsDir, 'escape.yaml');
    symlinkSync(outside, escapeLink);

    const catalog = listWorkflowCatalog({
      projectWorkflowsDir: workflowsDir,
      validate: true,
    });
    const entry = catalog.find((item) => item.id === 'escape');
    expect(entry).toBeDefined();
    expect(entry?.valid).toBe(false);
    const reason = entry?.validationError ?? '';
    expect(reason).toMatch(/超出模板目录|符号链接/u);
    // 关键安全断言：外部文件内容不得经解析错误片段回显。
    expect(reason).not.toContain('SECRET_TOKEN');
    expect(reason).not.toContain('hunter2');
  });

  it('rejects escaping symlinks on by-name loading (validate/show/run/web share the rule)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-tpl-byname-'));
    tempDirs.push(root);
    const workflowsDir = join(root, '.tekon', 'workflows');
    mkdirSync(workflowsDir, { recursive: true });
    const outside = join(root, 'secret.ini');
    writeFileSync(outside, 'SECRET_TOKEN: [unclosed\npw: hunter2\n');
    symlinkSync(outside, join(workflowsDir, 'byescape.yaml'));

    // core 按名加载器（内置回落、goal、engine 路径共用）必须在读取前拒绝。
    // 注意：Web 的项目自定义模板分支走各自的 loadProjectWorkflowIfPresent，
    // 在 Web 包内用同一 inspectTemplateSymlink 闸门并配 RPC 回归，不在此测。
    expect(() =>
      loadWorkflowTemplate({ name: 'byescape', workflowsDir }),
    ).toThrow(/超出模板目录|符号链接/u);

    // 目录内合法软链仍可按名加载，证明规则不误伤共享用法。
    writeFileSync(join(workflowsDir, 'inside-target.yaml'), validYaml);
    symlinkSync(
      join(workflowsDir, 'inside-target.yaml'),
      join(workflowsDir, 'inside-link.yaml'),
    );
    const loaded = loadWorkflowTemplate({
      name: 'inside-link',
      workflowsDir,
    });
    expect(loaded.id).toBe('minimal');
  });

  it('reports broken and directory symlinks as readable invalid entries', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-badlink-'));
    tempDirs.push(dir);
    symlinkSync(join(dir, 'does-not-exist.yaml'), join(dir, 'broken.yaml'));
    mkdirSync(join(dir, 'a-directory'));
    symlinkSync(join(dir, 'a-directory'), join(dir, 'dirlink.yaml'));

    const catalog = listWorkflowCatalog({
      projectWorkflowsDir: dir,
      validate: true,
    });
    const byId = new Map(catalog.map((entry) => [entry.id, entry]));
    const broken = byId.get('broken');
    const dirLink = byId.get('dirlink');
    expect(broken?.valid).toBe(false);
    expect(broken?.validationError ?? '').toMatch(/符号链接|无法解析/u);
    expect(dirLink?.valid).toBe(false);
    // EISDIR 不得裸抛英文 errno。
    expect(dirLink?.validationError ?? '').not.toContain('EISDIR');
  });

  it('catalog probe marks malformed project templates as invalid while valid ones stay valid', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-tpl-catalog-'));
    tempDirs.push(dir);
    const projectWorkflowsDir = join(dir, '.tekon', 'workflows');
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(join(projectWorkflowsDir, 'good.yaml'), validYaml);
    writeFileSync(
      join(projectWorkflowsDir, 'bad.yaml'),
      'id: bad\nphases: nope\n',
    );

    const catalog = listWorkflowCatalog({
      projectWorkflowsDir,
      validate: true,
    });
    const validity = new Map(
      catalog
        .filter((entry) => entry.builtin === false)
        .map((entry) => [entry.id, entry.valid ?? null]),
    );
    expect(validity.get('good')).toBe(true);
    expect(validity.get('bad')).toBe(false);

    // 默认不探测：保持既有目录扫描的零副作用形状（valid 缺省）。
    const plain = listWorkflowCatalog({ projectWorkflowsDir });
    expect(plain.every((entry) => entry.valid === undefined)).toBe(true);
  });
});
