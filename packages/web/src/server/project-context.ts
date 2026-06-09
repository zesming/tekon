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
  env?: NodeJS.ProcessEnv;
}

export function resolveProjectRoot(
  input: ResolveProjectRootInput = {},
): string {
  const explicitRoot = input.projectRoot ?? input.env?.TEKON_PROJECT_ROOT;
  if (!explicitRoot) {
    throw new Error(
      'TEKON_PROJECT_ROOT or an explicit projectRoot is required for Tekon Web',
    );
  }

  return resolve(explicitRoot);
}

export function createProjectContext(
  input: ResolveProjectRootInput = {},
): WebProjectContext {
  const projectRoot = resolveProjectRoot(input);
  const dataDir = join(projectRoot, '.tekon');
  return {
    projectRoot,
    dataDir,
    dbPath: join(dataDir, 'tekon.sqlite'),
    sessionPath: join(dataDir, 'web-session.json'),
    rolesDir: join(dataDir, 'roles'),
    workflowsDir: join(dataDir, 'workflows'),
    env: input.env,
  };
}

export function assertProjectDatabaseExists(context: WebProjectContext): void {
  if (!existsSync(context.dbPath)) {
    throw new Error(`Tekon database not found: ${context.dbPath}`);
  }
}
