import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['__tests__/api/**/*.test.ts'],
    exclude: ['__tests__/e2e/**'],
  },
});
