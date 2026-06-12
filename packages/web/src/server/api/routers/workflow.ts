import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ServerContext } from '../context.js';

export function createWorkflowRouter(context: ServerContext) {
  return {
    async list() {
      return { workflows: listWorkflows(context) };
    },
  };
}

function listWorkflows(
  context: ServerContext,
): Array<{ id: string; name: string; path: string }> {
  const workflowsDir = context.projectContext.workflowsDir;
  if (!existsSync(workflowsDir)) {
    return [];
  }

  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.ya?ml$/u.test(entry.name))
    .map((entry) => {
      const path = join(workflowsDir, entry.name);
      const content = readFileSync(path, 'utf8');
      return {
        id:
          extractYamlScalar(content, 'id') ??
          entry.name.replace(/\.ya?ml$/u, ''),
        name: extractYamlScalar(content, 'name') ?? entry.name,
        path,
      };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function extractYamlScalar(content: string, key: string): string | undefined {
  const match = new RegExp(`^${key}:\\s*(.+)$`, 'mu').exec(content);
  return match?.[1]?.trim().replace(/^["']|["']$/gu, '');
}
