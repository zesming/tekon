import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import {
  resolveSafeTekonPath,
  writeFileAtomically,
} from '../artifact/store.js';
import type { DiscoveredAgent } from '../runtime/agent-discovery.js';
import { resolveSupportedEfforts } from '../runtime/agent-discovery.js';
import {
  identifierSchema,
  type NodeContextMode,
  type NodeWorkspace,
  type Role,
} from '../types/domain.js';
import {
  loadWorkflowTemplate,
  loadWorkflowTemplateFile,
  parseWorkflowTemplate,
  type WorkflowTemplate,
} from './template.js';

export interface LinearWorkflowNodeInput {
  id: string;
  name: string;
  role: Role;
  workspace?: NodeWorkspace;
  docKey?: string;
  expectedDoc?: string;
  overrideModel?: string;
  overrideEffort?: string;
  overridePrompt?: string;
  contextMode?: NodeContextMode;
  confirmAfter?: boolean;
}

export interface LinearWorkflowRecord {
  id: string;
  name: string;
  description: string;
  builtIn: boolean;
  overridden: boolean;
  category: 'general' | 'delivery';
  nodes: LinearWorkflowNodeInput[];
}

export interface WorkflowStoreContext {
  repoPath: string;
  builtInWorkflowsDir: string;
}

const GENERAL_BUILT_IN_TEMPLATE_IDS = new Set([
  'deep-research',
  'quick-dev',
]);

function assertSafeTemplateId(id: string): string {
  const parsed = identifierSchema.safeParse(id);
  if (!parsed.success) {
    throw new Error(
      `WORKFLOW_ID_INVALID: 模板 ID '${id}' 必须为 kebab-case（小写字母开头，仅含小写字母、数字和连字符）。`,
    );
  }
  return parsed.data;
}

function projectWorkflowPath(repoPath: string, id: string): string {
  const safeId = assertSafeTemplateId(id);
  return resolveSafeTekonPath(repoPath, `.tekon/workflows/${safeId}.yaml`);
}

function toLinearRecord(
  template: WorkflowTemplate,
  meta: { builtIn: boolean; overridden: boolean },
): LinearWorkflowRecord {
  const flatNodes = template.phases.flatMap((p) => p.nodes);
  return {
    id: template.id,
    name: template.name,
    description: template.description ?? '',
    builtIn: meta.builtIn,
    overridden: meta.overridden,
    category:
      !meta.builtIn || GENERAL_BUILT_IN_TEMPLATE_IDS.has(template.id)
        ? 'general'
        : 'delivery',
    nodes: flatNodes.map((n, idx) => ({
      id: n.id,
      name: n.name ?? n.id,
      role: n.role,
      workspace: n.workspace,
      docKey: n.docKey ?? n.outputs[0]?.type ?? `step-${idx + 1}`,
      expectedDoc: n.expectedDoc ?? n.outputs[0]?.type ?? '',
      overrideModel: n.overrideModel ?? '',
      overrideEffort: n.overrideEffort ?? '',
      overridePrompt: n.overridePrompt ?? n.prompt ?? '',
      contextMode: n.contextMode ?? 'auto',
      confirmAfter:
        n.confirmAfter ?? n.gates.some((g) => g.type === 'human'),
    })),
  };
}

function serializeLinearWorkflowYaml(input: {
  id: string;
  name: string;
  description?: string;
  nodes: LinearWorkflowNodeInput[];
}): string {
  const doc: Record<string, unknown> = {
    id: assertSafeTemplateId(input.id),
    name: input.name.trim() || input.id,
    ...(input.description?.trim()
      ? { description: input.description.trim() }
      : {}),
    version: 2,
    nodes: input.nodes.map((n, idx) => {
      const nodeId = identifierSchema.safeParse(n.id).success
        ? n.id
        : `step-${idx + 1}`;
      const docKey =
        n.docKey && identifierSchema.safeParse(n.docKey).success
          ? n.docKey
          : undefined;
      return {
        id: nodeId,
        name: n.name.trim() || `步骤 ${idx + 1}`,
        role: n.role,
        ...(n.workspace ? { workspace: n.workspace } : {}),
        ...(n.contextMode ? { contextMode: n.contextMode } : {}),
        ...(docKey ? { docKey } : {}),
        ...(n.expectedDoc?.trim() ? { expectedDoc: n.expectedDoc.trim() } : {}),
        ...(n.overrideModel?.trim()
          ? { overrideModel: n.overrideModel.trim() }
          : {}),
        ...(n.overrideEffort?.trim()
          ? { overrideEffort: n.overrideEffort.trim() }
          : {}),
        ...(n.overridePrompt?.trim()
          ? { overridePrompt: n.overridePrompt.trim() }
          : {}),
        ...(n.confirmAfter ? { confirmAfter: true } : {}),
      };
    }),
  };
  return stringifyYaml(doc);
}

function listYamlIdsInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const dirReal = realpathSync(dir);
  const ids: string[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.yaml') && !name.endsWith('.yml')) continue;
    const full = join(dir, name);
    try {
      if (lstatSync(full).isSymbolicLink()) continue;
      const real = realpathSync(full);
      if (!real.startsWith(`${dirReal}${sep}`)) continue;
      const base = name.replace(/\.ya?ml$/u, '');
      if (identifierSchema.safeParse(base).success) {
        ids.push(base);
      }
    } catch {
      // skip unreadable entries
    }
  }
  return ids;
}

function loadProjectOrBuiltInTemplate(
  ctx: WorkflowStoreContext,
  id: string,
): WorkflowTemplate {
  const projectDir = resolve(ctx.repoPath, '.tekon', 'workflows');
  for (const ext of ['.yaml', '.yml']) {
    const projectFile = join(projectDir, `${id}${ext}`);
    if (existsSync(projectFile)) {
      return loadWorkflowTemplate({ name: id, workflowsDir: projectDir });
    }
  }
  return loadWorkflowTemplate({
    name: id,
    workflowsDir: ctx.builtInWorkflowsDir,
  });
}

export function listLinearWorkflows(
  ctx: WorkflowStoreContext,
  options: { includeDelivery?: boolean } = {},
): LinearWorkflowRecord[] {
  const builtInIds = new Set(listYamlIdsInDir(ctx.builtInWorkflowsDir));
  const projectDir = resolve(ctx.repoPath, '.tekon', 'workflows');
  const projectIds = new Set(listYamlIdsInDir(projectDir));
  const allIds = new Set([...builtInIds, ...projectIds]);

  const records: LinearWorkflowRecord[] = [];
  for (const id of allIds) {
    try {
      const template = loadProjectOrBuiltInTemplate(ctx, id);
      const rec = toLinearRecord(template, {
        builtIn: builtInIds.has(id),
        overridden: builtInIds.has(id) && projectIds.has(id),
      });
      if (!options.includeDelivery && rec.category === 'delivery') {
        continue;
      }
      records.push(rec);
    } catch {
      // skip invalid template files rather than breaking entire listing
    }
  }

  return records.sort((a, b) => {
    // General built-in first (deep-research, quick-dev), then custom, then delivery
    const rank = (r: LinearWorkflowRecord) =>
      r.id === 'deep-research'
        ? 0
        : r.id === 'quick-dev'
          ? 1
          : r.category === 'general'
            ? 2
            : 3;
    const diff = rank(a) - rank(b);
    return diff !== 0 ? diff : a.name.localeCompare(b.name, 'zh-CN');
  });
}

export function getLinearWorkflow(
  ctx: WorkflowStoreContext,
  id: string,
): LinearWorkflowRecord {
  const safeId = assertSafeTemplateId(id);
  const builtInExists =
    existsSync(join(ctx.builtInWorkflowsDir, `${safeId}.yaml`)) ||
    existsSync(join(ctx.builtInWorkflowsDir, `${safeId}.yml`));
  const projectPath = projectWorkflowPath(ctx.repoPath, safeId);
  const template = loadProjectOrBuiltInTemplate(ctx, safeId);
  return toLinearRecord(template, {
    builtIn: builtInExists,
    overridden: builtInExists && existsSync(projectPath),
  });
}

export function saveLinearWorkflow(
  ctx: WorkflowStoreContext,
  input: {
    id: string;
    name: string;
    description?: string;
    nodes: LinearWorkflowNodeInput[];
  },
): LinearWorkflowRecord {
  if (!input.nodes || input.nodes.length === 0) {
    throw new Error('WORKFLOW_INVALID: 模板至少需要包含 1 个节点。');
  }
  const safeId = assertSafeTemplateId(input.id);
  const yamlText = serializeLinearWorkflowYaml({ ...input, id: safeId });
  // Validate via parser BEFORE touching disk (fail-closed)
  parseWorkflowTemplate(yamlText);
  const targetPath = projectWorkflowPath(ctx.repoPath, safeId);
  mkdirSync(resolve(ctx.repoPath, '.tekon', 'workflows'), { recursive: true });
  writeFileAtomically(targetPath, yamlText);
  return getLinearWorkflow(ctx, safeId);
}

export function duplicateLinearWorkflow(
  ctx: WorkflowStoreContext,
  sourceId: string,
  newId?: string,
  newName?: string,
): LinearWorkflowRecord {
  const src = getLinearWorkflow(ctx, sourceId);
  const targetId = assertSafeTemplateId(
    newId ?? `${src.id}-copy-${Date.now().toString(36).slice(-4)}`,
  );
  return saveLinearWorkflow(ctx, {
    id: targetId,
    name: newName?.trim() || `${src.name} 副本`,
    description: src.description,
    nodes: src.nodes,
  });
}

export function deleteCustomWorkflow(
  ctx: WorkflowStoreContext,
  id: string,
): void {
  const safeId = assertSafeTemplateId(id);
  const builtInExists =
    existsSync(join(ctx.builtInWorkflowsDir, `${safeId}.yaml`)) ||
    existsSync(join(ctx.builtInWorkflowsDir, `${safeId}.yml`));
  if (builtInExists) {
    throw new Error(
      `WORKFLOW_BUILTIN_PROTECTED: 内置模板 '${safeId}' 不可删除，可使用恢复默认功能。`,
    );
  }
  const targetPath = projectWorkflowPath(ctx.repoPath, safeId);
  if (existsSync(targetPath)) {
    rmSync(targetPath);
  }
}

export function resetBuiltInWorkflow(
  ctx: WorkflowStoreContext,
  id: string,
): LinearWorkflowRecord {
  const safeId = assertSafeTemplateId(id);
  const builtInExists =
    existsSync(join(ctx.builtInWorkflowsDir, `${safeId}.yaml`)) ||
    existsSync(join(ctx.builtInWorkflowsDir, `${safeId}.yml`));
  if (!builtInExists) {
    throw new Error(`WORKFLOW_NOT_BUILTIN: '${safeId}' 不是内置模板，无法恢复默认。`);
  }
  const targetPath = projectWorkflowPath(ctx.repoPath, safeId);
  if (existsSync(targetPath)) {
    rmSync(targetPath);
  }
  return getLinearWorkflow(ctx, safeId);
}

/**
 * Finds all workflows (including delivery templates) that reference `roleId`.
 */
export function findWorkflowsReferencingRole(
  ctx: WorkflowStoreContext,
  roleId: Role,
): Array<{ id: string; name: string }> {
  const all = listLinearWorkflows(ctx, { includeDelivery: true });
  return all
    .filter((w) => w.nodes.some((n) => n.role === roleId))
    .map((w) => ({ id: w.id, name: w.name }));
}

/**
 * Automatically cleans up incompatible node-level model/effort overrides across
 * project workflow templates whenever a role changes its bound Agent/Model or resets.
 */
export function cleanupWorkflowOverridesForRole(
  ctx: WorkflowStoreContext,
  roleId: Role,
  agent: Pick<DiscoveredAgent, 'models' | 'efforts' | 'modelEfforts'> | undefined,
): string[] {
  if (!agent) return [];
  const cleaned: string[] = [];
  const all = listLinearWorkflows(ctx, { includeDelivery: true });
  for (const wf of all) {
    let dirty = false;
    const nextNodes = wf.nodes.map((n) => {
      if (n.role !== roleId) return n;
      let nextModel = n.overrideModel ?? '';
      let nextEffort = n.overrideEffort ?? '';
      if (nextModel && !agent.models.includes(nextModel)) {
        nextModel = '';
        dirty = true;
      }
      const allowedEfforts = resolveSupportedEfforts(
        agent,
        nextModel || undefined,
      );
      if (
        nextEffort &&
        (!allowedEfforts.includes(nextEffort) ||
          (allowedEfforts.length === 1 && allowedEfforts[0] === 'default'))
      ) {
        nextEffort = '';
        dirty = true;
      }
      return dirty
        ? { ...n, overrideModel: nextModel, overrideEffort: nextEffort }
        : n;
    });
    if (dirty) {
      saveLinearWorkflow(ctx, {
        id: wf.id,
        name: wf.name,
        description: wf.description,
        nodes: nextNodes,
      });
      cleaned.push(wf.id);
    }
  }
  return cleaned;
}
