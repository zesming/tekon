import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';

import { stringify as stringifyYaml } from 'yaml';

import {
  resolveSafeTekonPath,
  writeFileAtomically,
} from '../artifact/store.js';
import type { DiscoveredAgent } from '../runtime/agent-discovery.js';
import {
  GENERAL_ROLE_IDS,
  roleSchema,
  type Role,
} from '../types/domain.js';
import {
  cleanupWorkflowOverridesForRole,
  findWorkflowsReferencingRole,
} from '../workflow/template-store.js';
import { listRoleIds, loadRole, type LoadedRole } from './loader.js';
import {
  assertValidRolePrompt,
  materializeProjectRole,
} from './project-overrides.js';

export interface RoleRecord {
  id: Role;
  name: string;
  description: string;
  builtIn: boolean;
  overridden: boolean;
  category: 'general' | 'delivery';
  driver: string;
  model: string;
  effort: string;
  isolated: boolean;
  systemPrompt: string;
}

export interface RoleStoreContext {
  repoPath: string;
  builtInRolesDir: string;
  builtInWorkflowsDir: string;
  userHome?: string;
}

export interface SaveRoleInput {
  id: Role;
  name?: string;
  description?: string;
  driver?: string;
  model?: string;
  effort?: string;
  isolated?: boolean;
  systemPrompt: string;
}

const GENERAL_ROLE_SET = new Set<string>(GENERAL_ROLE_IDS);

function toRoleRecord(
  loaded: LoadedRole,
  meta: { builtIn: boolean; overridden: boolean },
): RoleRecord {
  const category =
    loaded.agent.category ??
    (meta.builtIn && !GENERAL_ROLE_SET.has(loaded.role)
      ? 'delivery'
      : 'general');
  return {
    id: loaded.role,
    name: loaded.agent.name ?? loaded.role,
    description: loaded.agent.description ?? '',
    builtIn: meta.builtIn,
    overridden: meta.overridden,
    category,
    driver: loaded.agent.driver ?? '',
    model: loaded.agent.model ?? '',
    effort: loaded.agent.effort ?? '',
    isolated: Boolean(loaded.agent.isolated),
    systemPrompt: loaded.systemPrompt,
  };
}

export function listRolesDetailed(
  ctx: RoleStoreContext,
  options: { includeDelivery?: boolean } = {},
): RoleRecord[] {
  const builtInIds = new Set(listRoleIds(ctx.builtInRolesDir));
  const projectRolesDir = join(ctx.repoPath, '.tekon', 'roles');
  const projectIds = new Set(
    listRoleIds(projectRolesDir).filter((id) =>
      existsSync(join(projectRolesDir, id, 'agent.yaml')),
    ),
  );
  const allIds = new Set([...builtInIds, ...projectIds]);

  const records: RoleRecord[] = [];
  for (const id of allIds) {
    try {
      const loaded = loadRole({
        role: id,
        repoPath: ctx.repoPath,
        builtInRolesDir: ctx.builtInRolesDir,
        userHome: ctx.userHome,
      });
      const rec = toRoleRecord(loaded, {
        builtIn: builtInIds.has(id),
        overridden: builtInIds.has(id) && projectIds.has(id),
      });
      if (!options.includeDelivery && rec.category === 'delivery') {
        continue;
      }
      records.push(rec);
    } catch {
      // skip corrupted directory rather than breaking list
    }
  }

  const order = ['explorer', 'designer', 'reviewer', 'coder', 'orchestrator'];
  return records.sort((a, b) => {
    const ai = order.indexOf(a.id);
    const bi = order.indexOf(b.id);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.id.localeCompare(b.id);
  });
}

export function saveRoleConfig(
  ctx: RoleStoreContext,
  input: SaveRoleInput,
  options: { resolvedAgent?: DiscoveredAgent } = {},
): { role: RoleRecord; cleanedWorkflows: string[] } {
  const roleId = roleSchema.parse(input.id);
  assertValidRolePrompt(input.systemPrompt);

  // Ensure project override directory exists safely (copies built-in or scaffolds)
  materializeProjectRole({
    role: roleId,
    repoPath: ctx.repoPath,
    builtInRolesDir: ctx.builtInRolesDir,
  });

  const existing = loadRole({
    role: roleId,
    repoPath: ctx.repoPath,
    builtInRolesDir: ctx.builtInRolesDir,
    userHome: ctx.userHome,
  });

  const agentYamlObj: Record<string, unknown> = {
    role: roleId,
    name: input.name?.trim() || existing.agent.name || roleId,
    ...(input.description !== undefined
      ? input.description.trim()
        ? { description: input.description.trim() }
        : {}
      : existing.agent.description
        ? { description: existing.agent.description }
        : {}),
    ...(input.driver?.trim() ? { driver: input.driver.trim() } : {}),
    ...(input.model?.trim() ? { model: input.model.trim() } : {}),
    ...(input.effort?.trim() ? { effort: input.effort.trim() } : {}),
    isolated: input.isolated ?? existing.agent.isolated ?? false,
    category: existing.agent.category ?? 'general',
    injectMode: existing.agent.injectMode,
    priority: existing.agent.priority,
    ...(existing.agent.maxSkills !== undefined
      ? { maxSkills: existing.agent.maxSkills }
      : {}),
    ...(existing.agent.knowledgeFiles.length > 0
      ? { knowledgeFiles: existing.agent.knowledgeFiles }
      : {}),
  };

  const agentYamlPath = resolveSafeTekonPath(
    ctx.repoPath,
    `.tekon/roles/${roleId}/agent.yaml`,
  );
  const systemMdPath = resolveSafeTekonPath(
    ctx.repoPath,
    `.tekon/roles/${roleId}/system.md`,
  );

  writeFileAtomically(agentYamlPath, stringifyYaml(agentYamlObj));
  writeFileAtomically(systemMdPath, input.systemPrompt);

  const cleanedWorkflows = cleanupWorkflowOverridesForRole(
    {
      repoPath: ctx.repoPath,
      builtInWorkflowsDir: ctx.builtInWorkflowsDir,
    },
    roleId,
    options.resolvedAgent,
  );

  const reloaded = loadRole({
    role: roleId,
    repoPath: ctx.repoPath,
    builtInRolesDir: ctx.builtInRolesDir,
    userHome: ctx.userHome,
  });
  const builtIn = existsSync(join(ctx.builtInRolesDir, roleId, 'agent.yaml'));
  return {
    role: toRoleRecord(reloaded, { builtIn, overridden: builtIn }),
    cleanedWorkflows,
  };
}

export function duplicateRoleConfig(
  ctx: RoleStoreContext,
  sourceId: Role,
  newId?: string,
  newName?: string,
): RoleRecord {
  const loaded = loadRole({
    role: roleSchema.parse(sourceId),
    repoPath: ctx.repoPath,
    builtInRolesDir: ctx.builtInRolesDir,
    userHome: ctx.userHome,
  });
  const targetId = roleSchema.parse(
    newId ?? `${loaded.role}-copy-${Date.now().toString(36).slice(-4)}`,
  );
  const { role } = saveRoleConfig(ctx, {
    id: targetId,
    name: newName?.trim() || `${loaded.agent.name ?? loaded.role} 副本`,
    description: loaded.agent.description,
    driver: loaded.agent.driver,
    model: loaded.agent.model,
    effort: loaded.agent.effort,
    isolated: loaded.agent.isolated,
    systemPrompt: loaded.systemPrompt,
  });
  return role;
}

export function deleteCustomRole(
  ctx: RoleStoreContext,
  roleId: Role,
  options: { defaultOrchestrator?: string } = {},
): void {
  const safeId = roleSchema.parse(roleId);
  if (existsSync(join(ctx.builtInRolesDir, safeId, 'agent.yaml'))) {
    throw new Error(
      `ROLE_BUILTIN_PROTECTED: 内置角色 '${safeId}' 不可删除，请使用恢复默认功能。`,
    );
  }
  if (options.defaultOrchestrator === safeId) {
    throw new Error(
      `ROLE_IN_USE: 角色 '${safeId}' 正被设为默认编排者，请先在设置中更换默认编排者。`,
    );
  }
  const refs = findWorkflowsReferencingRole(
    {
      repoPath: ctx.repoPath,
      builtInWorkflowsDir: ctx.builtInWorkflowsDir,
    },
    safeId,
  );
  if (refs.length > 0) {
    throw new Error(
      `ROLE_IN_USE: 角色 '${safeId}' 正被模板「${refs.map((r) => r.name).join('、')}」引用，请先在模板中替换后再删除。`,
    );
  }

  const targetDir = resolveSafeTekonPath(ctx.repoPath, `.tekon/roles/${safeId}`);
  if (existsSync(targetDir)) {
    if (lstatSync(targetDir).isSymbolicLink()) {
      throw new Error(`ROLE_PATH_UNSAFE: 拒绝删除符号链接目录 ${safeId}`);
    }
    const rolesRootReal = realpathSync(join(ctx.repoPath, '.tekon', 'roles'));
    const targetReal = realpathSync(targetDir);
    if (!targetReal.startsWith(`${rolesRootReal}/`)) {
      throw new Error(`ROLE_PATH_UNSAFE: 目标目录越界 ${safeId}`);
    }
    rmSync(targetDir, { recursive: true, force: true });
  }
}

export function resetBuiltInRole(
  ctx: RoleStoreContext,
  roleId: Role,
  options: { resolvedAgent?: DiscoveredAgent } = {},
): { role: RoleRecord; cleanedWorkflows: string[] } {
  const safeId = roleSchema.parse(roleId);
  if (!existsSync(join(ctx.builtInRolesDir, safeId, 'agent.yaml'))) {
    throw new Error(`ROLE_NOT_BUILTIN: '${safeId}' 不是内置角色，无法恢复默认。`);
  }
  const targetDir = resolveSafeTekonPath(ctx.repoPath, `.tekon/roles/${safeId}`);
  if (existsSync(targetDir)) {
    mkdirSync(join(ctx.repoPath, '.tekon', 'roles'), { recursive: true });
    rmSync(targetDir, { recursive: true, force: true });
  }
  const cleanedWorkflows = cleanupWorkflowOverridesForRole(
    {
      repoPath: ctx.repoPath,
      builtInWorkflowsDir: ctx.builtInWorkflowsDir,
    },
    safeId,
    options.resolvedAgent,
  );
  const loaded = loadRole({
    role: safeId,
    repoPath: ctx.repoPath,
    builtInRolesDir: ctx.builtInRolesDir,
    userHome: ctx.userHome,
  });
  return {
    role: toRoleRecord(loaded, { builtIn: true, overridden: false }),
    cleanedWorkflows,
  };
}
