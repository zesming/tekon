import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  evaluateConstraints,
  loadConstraintRules,
  type ConstraintRule,
} from '../../src/constraint/dsl.js';

describe('loadConstraintRules', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns empty array when constraints.yaml does not exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-dsl-no-file-'));
    tempDirs.push(dir);

    expect(loadConstraintRules(dir)).toEqual([]);
  });

  it('loads and validates rules from a valid constraints.yaml', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-dsl-valid-'));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, 'constraints.yaml'),
      `
rules:
  - id: test-rule
    when:
      tags: [code-changes]
    then:
      - type: requiresGate
        gateType: build
`,
      'utf8',
    );

    const rules = loadConstraintRules(dir);

    expect(rules).toHaveLength(1);
    expect(rules[0]!.id).toBe('test-rule');
    expect(rules[0]!.when.tags).toEqual(['code-changes']);
    expect(rules[0]!.then).toEqual([
      { type: 'requiresGate', gateType: 'build' },
    ]);
  });

  it('rejects invalid action types', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tekon-dsl-invalid-'));
    tempDirs.push(dir);
    writeFileSync(
      join(dir, 'constraints.yaml'),
      `
rules:
  - id: bad-rule
    when:
      tags: [test]
    then:
      - type: unknownAction
        foo: bar
`,
      'utf8',
    );

    expect(() => loadConstraintRules(dir)).toThrow();
  });

  it('loads the real constraints.yaml from the repo root', () => {
    const repoRoot = new URL('../../../../', import.meta.url).pathname;
    const rules = loadConstraintRules(repoRoot);

    expect(rules.length).toBeGreaterThanOrEqual(3);
    const ids = rules.map((rule) => rule.id);
    expect(ids).toContain('code-changes-need-build-test');
    expect(ids).toContain('high-risk-needs-human-review');
    expect(ids).toContain('security-changes-need-scan');
  });
});

describe('evaluateConstraints', () => {
  const rules: ConstraintRule[] = [
    {
      id: 'code-needs-build',
      when: { tags: ['code-changes'] },
      then: [
        { type: 'requiresGate', gateType: 'build' },
        { type: 'requiresGate', gateType: 'test' },
      ],
    },
    {
      id: 'high-risk-human',
      when: { riskLevel: ['high'] },
      then: [
        { type: 'requiresGate', gateType: 'human', gateKey: 'high-risk' },
      ],
    },
    {
      id: 'security-scan',
      when: { tags: ['security', 'auth'] },
      then: [{ type: 'requiresGate', gateType: 'security-scan' }],
    },
    {
      id: 'suggest-dry-run',
      when: { tags: ['experimental'] },
      then: [{ type: 'suggest', message: 'Consider a dry-run preview.' }],
    },
    {
      id: 'file-protect',
      when: { filePatterns: ['*.env', '**/secrets/**'] },
      then: [
        { type: 'requiresGate', gateType: 'human', gateKey: 'file-protect' },
      ],
    },
  ];

  it('returns empty results when no rules match', () => {
    const result = evaluateConstraints(rules, {
      tags: ['docs-only'],
      riskLevel: 'low',
    });

    expect(result.required).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it('returns required gates when tags match', () => {
    const result = evaluateConstraints(rules, {
      tags: ['code-changes'],
    });

    expect(result.required).toHaveLength(2);
    expect(result.required).toEqual([
      { type: 'requiresGate', gateType: 'build' },
      { type: 'requiresGate', gateType: 'test' },
    ]);
  });

  it('returns required gates when riskLevel matches', () => {
    const result = evaluateConstraints(rules, { riskLevel: 'high' });

    expect(result.required).toEqual([
      { type: 'requiresGate', gateType: 'human', gateKey: 'high-risk' },
    ]);
  });

  it('accumulates actions from multiple matching rules', () => {
    const result = evaluateConstraints(rules, {
      tags: ['code-changes', 'auth'],
      riskLevel: 'high',
    });

    expect(result.required).toHaveLength(4);
    expect(result.required.map((a) => ('gateType' in a ? a.gateType : null))).toEqual([
      'build',
      'test',
      'human',
      'security-scan',
    ]);
  });

  it('separates suggestions from required actions', () => {
    const result = evaluateConstraints(rules, {
      tags: ['experimental'],
    });

    expect(result.required).toEqual([]);
    expect(result.suggestions).toEqual([
      { type: 'suggest', message: 'Consider a dry-run preview.' },
    ]);
  });

  it('matches rules based on file patterns', () => {
    const result = evaluateConstraints(rules, {
      files: ['.env'],
    });

    expect(result.required).toEqual([
      { type: 'requiresGate', gateType: 'human', gateKey: 'file-protect' },
    ]);
  });

  it('matches recursive file patterns', () => {
    const result = evaluateConstraints(rules, {
      files: ['config/secrets/api-key.txt'],
    });

    expect(result.required).toEqual([
      { type: 'requiresGate', gateType: 'human', gateKey: 'file-protect' },
    ]);
  });

  it('performs case-insensitive tag matching', () => {
    const result = evaluateConstraints(rules, {
      tags: ['CODE-CHANGES', 'Auth'],
    });

    expect(result.required).toHaveLength(3);
  });

  it('handles empty context', () => {
    const result = evaluateConstraints(rules, {});

    expect(result.required).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it('handles empty rules array', () => {
    const result = evaluateConstraints([], {
      tags: ['code-changes'],
      riskLevel: 'high',
    });

    expect(result.required).toEqual([]);
    expect(result.suggestions).toEqual([]);
  });

  it('matches multiple tags with OR semantics within a rule', () => {
    const result = evaluateConstraints(rules, {
      tags: ['security'],
    });

    expect(result.required).toEqual([
      { type: 'requiresGate', gateType: 'security-scan' },
    ]);
  });
});
