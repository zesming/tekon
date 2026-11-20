import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deleteCustomRole,
  duplicateRoleConfig,
  listRolesDetailed,
  resetBuiltInRole,
  saveRoleConfig,
} from '../../src/role/role-store.js';
import {
  deleteCustomWorkflow,
  duplicateLinearWorkflow,
  getLinearWorkflow,
  listLinearWorkflows,
  resetBuiltInWorkflow,
  saveLinearWorkflow,
} from '../../src/workflow/template-store.js';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..', '..');
const BUILT_IN_ROLES = join(REPO_ROOT, 'roles');
const BUILT_IN_WORKFLOWS = join(REPO_ROOT, 'workflows');

const tempDirs: string[] = [];
function makeTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tekon-store-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('role-store and template-store CRUD, reference protection, and cascading override cleanup', () => {
  it('lists 5 general built-in roles and 2 general linear templates while preserving delivery templates when requested', () => {
    const repoPath = makeTempRepo();
    const generalRoles = listRolesDetailed({
      repoPath,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
    });
    expect(generalRoles.map((r) => r.id)).toEqual([
      'explorer',
      'designer',
      'reviewer',
      'coder',
      'orchestrator',
    ]);
    expect(generalRoles.find((r) => r.id === 'reviewer')?.isolated).toBe(true);

    const generalWorkflows = listLinearWorkflows({
      repoPath,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
    });
    expect(generalWorkflows.map((w) => w.id)).toEqual(['deep-research', 'quick-dev']);

    const allWorkflows = listLinearWorkflows(
      { repoPath, builtInWorkflowsDir: BUILT_IN_WORKFLOWS },
      { includeDelivery: true },
    );
    expect(allWorkflows.some((w) => w.id === 'lightweight-delivery')).toBe(true);
  });

  it('cleans up incompatible cross-provider template overrides when role changes agent or resets, and blocks deleting referenced roles', () => {
    const repoPath = makeTempRepo();
    const roleCtx = {
      repoPath,
      builtInRolesDir: BUILT_IN_ROLES,
      builtInWorkflowsDir: BUILT_IN_WORKFLOWS,
    };
    const wfCtx = { repoPath, builtInWorkflowsDir: BUILT_IN_WORKFLOWS };

    // Create custom role + template referencing it with codex model override
    const copy = duplicateRoleConfig(roleCtx, 'explorer', 'custom-researcher', '定制调研员');
    expect(copy.builtIn).toBe(false);

    saveLinearWorkflow(wfCtx, {
      id: 'custom-flow',
      name: '定制调研流',
      nodes: [
        {
          id: 'step-1',
          name: '调研',
          role: 'custom-researcher',
          overrideModel: 'gpt-5.4',
          overrideEffort: 'xhigh',
          contextMode: 'auto',
          docKey: 'report',
          expectedDoc: '报告',
        },
      ],
    });

    // Cannot delete referenced custom role
    expect(() => deleteCustomRole(roleCtx, 'custom-researcher')).toThrow(/ROLE_IN_USE/u);

    // Switch role to claude-code -> template's gpt-5.4 / xhigh overrides must be auto-cleaned!
    const saved = saveRoleConfig(
      roleCtx,
      {
        id: 'custom-researcher',
        name: '定制调研员',
        driver: 'claude-code',
        model: 'claude-sonnet-4-6',
        effort: 'default',
        systemPrompt: '更新后的系统提示词',
      },
      {
        resolvedAgent: {
          id: 'claude-code',
          name: 'Claude Code',
          iconKey: 'claude-code',
          status: 'ready',
          models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
          efforts: ['default'],
          source: 'built-in',
        },
      },
    );
    expect(saved.cleanedWorkflows).toContain('custom-flow');
    const wfAfter = getLinearWorkflow(wfCtx, 'custom-flow');
    expect(wfAfter.nodes[0]?.overrideModel).toBe('');
    expect(wfAfter.nodes[0]?.overrideEffort).toBe('');

    // Built-in role & workflow duplicate / reset / delete protection
    expect(() => deleteCustomRole(roleCtx, 'explorer')).toThrow(/ROLE_BUILTIN_PROTECTED/u);
    expect(() => deleteCustomWorkflow(wfCtx, 'deep-research')).toThrow(/WORKFLOW_BUILTIN_PROTECTED/u);

    const wfCopy = duplicateLinearWorkflow(wfCtx, 'deep-research', 'deep-research-copy');
    expect(wfCopy.builtIn).toBe(false);
    deleteCustomWorkflow(wfCtx, 'deep-research-copy');
    deleteCustomWorkflow(wfCtx, 'custom-flow');

    // Now custom role is unreferenced -> deletion succeeds
    deleteCustomRole(roleCtx, 'custom-researcher');
    expect(listRolesDetailed(roleCtx).some((r) => r.id === 'custom-researcher')).toBe(false);

    // Resetting built-in role restores defaults
    saveRoleConfig(roleCtx, {
      id: 'explorer',
      driver: 'codex',
      model: 'gpt-5.4',
      effort: 'high',
      systemPrompt: '临时修改',
    });
    const reset = resetBuiltInRole(roleCtx, 'explorer');
    expect(reset.role.overridden).toBe(false);

    saveLinearWorkflow(wfCtx, {
      id: 'deep-research',
      name: '修改名',
      nodes: [{ id: 'n1', name: '单步', role: 'explorer' }],
    });
    const resetWf = resetBuiltInWorkflow(wfCtx, 'deep-research');
    expect(resetWf.nodes).toHaveLength(4);

    // Fail-closed: saving an invalid workflow (duplicate node IDs) must NOT overwrite existing valid file
    saveLinearWorkflow(wfCtx, {
      id: 'safe-flow',
      name: 'Valid Flow',
      nodes: [{ id: 'step-a', name: 'Step A', role: 'explorer' }],
    });
    expect(() =>
      saveLinearWorkflow(wfCtx, {
        id: 'safe-flow',
        name: 'Broken Flow',
        nodes: [
          { id: 'dup', name: 'One', role: 'explorer' },
          { id: 'dup', name: 'Two', role: 'designer' },
        ],
      }),
    ).toThrow();
    const preserved = getLinearWorkflow(wfCtx, 'safe-flow');
    expect(preserved.name).toBe('Valid Flow');
    expect(preserved.nodes).toHaveLength(1);
  });
});
