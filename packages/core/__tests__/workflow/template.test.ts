import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  listWorkflowCatalog,
  loadWorkflowTemplate,
  parseWorkflowTemplate,
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

  it('rejects missing reviewer, code nodes without build/lint, invalid artifact dependencies, and conflicting parallel outputs', () => {
    expect(() =>
      parseWorkflowTemplate(`
id: no-reviewer
phases:
  - id: code
    nodes:
      - id: rd-code
        role: rd
        outputs: [code-changes]
        gates:
          - type: build
          - type: lint
  - id: validation
    nodes:
      - id: qa-test
        role: qa
`),
    ).toThrow(/reviewer/u);

    expect(() =>
      parseWorkflowTemplate(`
id: missing-gates
phases:
  - id: code
    nodes:
      - id: rd-code
        role: rd
        outputs: [code-changes]
  - id: validation
    nodes:
      - id: qa-test
        role: qa
  - id: review
    nodes:
      - id: reviewer-check
        role: reviewer
`),
    ).toThrow(/build.*lint/u);

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
  - id: parallel
    parallel: true
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

  // 4b: `governance: none` is a WHITELIST exemption for lightweight goal runs.
  // It must exempt ONLY the required-reviewer invariant, and must not leak to
  // templates that omit the field (default 'standard').
  it('allows a reviewer-less single-node template only when governance is none', () => {
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
    expect(goal.phases).toHaveLength(1);
    expect(goal.phases[0].nodes[0]).toMatchObject({ role: 'goal', gates: [] });
  });

  it('still requires a reviewer node when governance is standard/omitted (exemption does not leak)', () => {
    // Same shape as the goal template but WITHOUT the governance marker.
    expect(() =>
      parseWorkflowTemplate(`
id: goal-without-marker
phases:
  - id: goal
    nodes:
      - id: goal-execute
        role: goal
`),
    ).toThrow(/reviewer/u);

    // An explicit governance: standard must also still enforce it.
    expect(() =>
      parseWorkflowTemplate(`
id: standard-no-reviewer
governance: standard
phases:
  - id: code
    nodes:
      - id: rd-code
        role: rd
`),
    ).toThrow(/reviewer/u);
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
