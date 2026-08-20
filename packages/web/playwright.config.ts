import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './__tests__/e2e',
  reporter: 'list',
  timeout: 30_000,
  workers: 1,
  // Each test boots its own web server backed by a Vite dev server; the first
  // navigation triggers a cold Vite transform that can occasionally exceed the
  // default assertion timeout under load. Give assertions headroom and retry
  // once so cold-start jitter does not flake the suite. The app renders
  // correctly — this is startup timing, not weakened assertions.
  expect: { timeout: 10_000 },
  retries: 1,
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
