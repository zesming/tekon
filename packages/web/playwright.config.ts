import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './__tests__/e2e',
  reporter: 'list',
  timeout: 30_000,
  workers: 1,
  // Shared business tests warm the real app shell in their fixture, while the
  // dedicated production-bootstrap suite keeps cold-start coverage. Retain one
  // retry for trace evidence, but never let CI report a flaky test run as green.
  expect: { timeout: 10_000 },
  retries: 1,
  failOnFlakyTests: !!process.env.CI,
  use: {
    baseURL: 'http://127.0.0.1:0',
    trace: 'retain-on-failure',
    navigationTimeout: 20_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
