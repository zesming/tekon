import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_WORKFLOW_TEMPLATE_ID,
  loadWorkflowTemplate,
  validateRunPlanV3,
  captureRunPlan,
  listWorkflowCatalog,
} from '../../src/index.js';
import { validateWorkflowTemplateFile } from '../../src/workflow/template.js';

// PD-08：轻量默认模板 lightweight-delivery 的形状与计划层合同。
const here = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');
const templateFile = join(repoRoot, 'workflows', 'lightweight-delivery.yaml');

describe('PD-08 lightweight-delivery template', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function makeRepo(): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-lightweight-'));
    tempDirs.push(repoPath);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: repoPath, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.email', 'tekon@example.com');
    git('config', 'user.name', 'Tekon Test');
    return repoPath;
  }

  it('passes file validation and loads as a built-in template', () => {
    const result = validateWorkflowTemplateFile(templateFile);
    expect(result.valid).toBe(true);

    const template = loadWorkflowTemplate({ name: 'lightweight-delivery' });
    expect(template.id).toBe('lightweight-delivery');
  });

  it('has exactly 3 phases, 3 nodes, 3 gates (2 schema + 1 human) and 2 artifacts', () => {
    const template = loadWorkflowTemplate({ name: 'lightweight-delivery' });

    expect(template.phases).toHaveLength(3);
    const nodes = template.phases.flatMap((phase) => phase.nodes);
    expect(nodes.map((node) => node.id)).toEqual([
      'pm-plan',
      'rd-implement',
      'human-confirm',
    ]);

    const gates = nodes.flatMap((node) => node.gates ?? []);
    expect(gates).toHaveLength(3);
    expect(gates.filter((gate) => gate.type === 'schema')).toHaveLength(2);
    expect(gates.filter((gate) => gate.type === 'human')).toHaveLength(1);

    const artifacts = nodes.flatMap((node) =>
      (node.outputs ?? []).map((ref) => ref.type),
    );
    expect(artifacts).toEqual(['demand-card', 'code-changes']);
  });

  it('uses an output-less reviewer confirm node whose human gate reworks rd-implement', () => {
    const template = loadWorkflowTemplate({ name: 'lightweight-delivery' });
    const confirm = template.phases
      .flatMap((phase) => phase.nodes)
      .find((node) => node.id === 'human-confirm');

    expect(confirm).toBeDefined();
    expect(confirm?.role).toBe('reviewer');
    expect(confirm?.outputs ?? []).toHaveLength(0);
    const humanGate = confirm?.gates?.find((gate) => gate.type === 'human');
    expect(humanGate && 'reworkTargetNodeId' in humanGate).toBe(true);
    expect(
      (humanGate as { reworkTargetNodeId?: string }).reworkTargetNodeId,
    ).toBe('rd-implement');
  });

  it('captures a V3 plan and round-trips through validation without loss', () => {
    const repoPath = makeRepo();
    const template = loadWorkflowTemplate({ name: 'lightweight-delivery' });
    const plan = captureRunPlan(repoPath, template, {
      templateId: 'lightweight-delivery',
      agent: 'mock',
    });

    expect(plan.digestVersion).toBe(3);
    const reparsed = validateRunPlanV3(plan);
    const reparseNodes = reparsed.template.phases.flatMap(
      (phase) => phase.nodes,
    );
    expect(reparseNodes).toHaveLength(3);
    expect(reparsed.template.phases).toHaveLength(3);
  });

  it('appears in the built-in workflow catalog', () => {
    const catalog = listWorkflowCatalog();
    expect(catalog.some((entry) => entry.id === 'lightweight-delivery')).toBe(
      true,
    );
  });

  it('exposes the template id as the single default constant', () => {
    expect(DEFAULT_WORKFLOW_TEMPLATE_ID).toBe('lightweight-delivery');
    // 缺省常量必须对应一个真实可加载的内置模板。
    expect(() =>
      loadWorkflowTemplate({ name: DEFAULT_WORKFLOW_TEMPLATE_ID }),
    ).not.toThrow();
  });
});
