import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const isRepoRoot = resolve(process.cwd()) === resolve(repoRoot);

export default defineConfig({
  test: {
    ...(isRepoRoot ? { projects: ['packages/*'] } : {}),
  },
});
