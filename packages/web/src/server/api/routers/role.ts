import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

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

  return readdirSync(rolesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const systemPath = join(rolesDir, entry.name, 'system.md');
      return {
        id: entry.name,
        name: entry.name.toUpperCase(),
        hasSystemPrompt: existsSync(systemPath),
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}
