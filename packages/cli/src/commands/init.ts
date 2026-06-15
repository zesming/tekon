import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import type { CliIO } from '../lib/context.js';
import {
  ensureInitialized,
  initializeProject,
} from '../lib/context.js';
import {
  findGitRoot,
  findInitializedRepoRoot,
} from '../lib/path-utils.js';

function resolveRepoPathForInit(repoArg?: string): string {
  if (repoArg) {
    return resolve(repoArg);
  }
  return (
    findInitializedRepoRoot(process.cwd()) ??
    findGitRoot() ??
    resolve(process.cwd())
  );
}

export async function commandInit(
  argv: string[],
  io: CliIO,
) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveRepoPathForInit(args.values.repo);
  initializeProject(repoPath, io);
}
