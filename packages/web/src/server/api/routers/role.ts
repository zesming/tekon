import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { listRoleIds } from '@tekon/core';

import type { ServerContext } from '../context.js';

export function createRoleRouter(context: ServerContext) {
  return {
    async list() {
      return { roles: listRoles(context) };
    },
  };
}

function listRoles(
  context: ServerContext,
): Array<{ id: string; name: string; hasSystemPrompt: boolean }> {
  const rolesDir = context.projectContext.rolesDir;
  if (!existsSync(rolesDir)) {
    return [];
  }

  // 与 CLI/core 入口一致：只列 kebab-case 标识符角色，忽略 .DS_Store 等
  // 非标识符目录（PD-06 开放命名的入口一致性）。
  return listRoleIds(rolesDir)
    .map((id) => {
      const systemPath = join(rolesDir, id, 'system.md');
      return {
        id,
        name: id.toUpperCase(),
        hasSystemPrompt: existsSync(systemPath),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
