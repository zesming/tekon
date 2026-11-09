import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('.', import.meta.url));
const isRepoRoot = resolve(process.cwd()) === resolve(repoRoot);

export default defineConfig({
  test: {
    ...(isRepoRoot ? { projects: ['packages/*'] } : {}),
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      // Vitest 4 removed coverage.all; listing sources keeps untested files in the report.
      include: ['packages/*/src/**/*.{ts,tsx}'],
      exclude: [
        '**/dist/**',
        '**/*.config.ts',
        'scripts/**',
        'packages/web/src/client/**',
        'packages/web/src/server/index.ts',
      ],
    },
  },
});
