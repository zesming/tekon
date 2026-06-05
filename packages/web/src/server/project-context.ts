import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export interface ResolveProjectRootInput {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WebProjectContext {
  projectRoot: string;
  dataDir: string;
  dbPath: string;
  sessionPath: string;
  rolesDir: string;
  workflowsDir: string;
}

export function resolveProjectRoot(
  input: ResolveProjectRootInput = {},
): string {
  const explicitRoot = input.projectRoot ?? input.env?.DONKEY_PROJECT_ROOT;
  if (!explicitRoot) {
    throw new Error(
      'DONKEY_PROJECT_ROOT or an explicit projectRoot is required for Donkey Web',
    );
  }

  return resolve(explicitRoot);
}

export function createProjectContext(
  input: ResolveProjectRootInput = {},
): WebProjectContext {
  const projectRoot = resolveProjectRoot(input);
  const dataDir = join(projectRoot, '.donkey');
  return {
    projectRoot,
    dataDir,
    dbPath: join(dataDir, 'donkey.sqlite'),
    sessionPath: join(dataDir, 'web-session.json'),
    rolesDir: join(dataDir, 'roles'),
    workflowsDir: join(dataDir, 'workflows'),
  };
}

export function assertProjectDatabaseExists(context: WebProjectContext): void {
  if (!existsSync(context.dbPath)) {
    throw new Error(`Donkey database not found: ${context.dbPath}`);
  }
}
