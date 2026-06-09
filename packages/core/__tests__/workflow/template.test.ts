import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
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
        { type: 'build' },
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
    ]) {
      expect(loadWorkflowTemplate({ name })).toMatchObject({ id: name });
    }
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
});
