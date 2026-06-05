import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './__tests__/e2e',
  reporter: 'list',
  timeout: 30_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:0',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
