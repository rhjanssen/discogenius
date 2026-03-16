import { defineConfig } from '@playwright/test';

const baseURL = process.env.BASE_URL || 'http://127.0.0.1:3737';
const shouldManageServer = !process.env.BASE_URL;

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  use: {
    baseURL,
    headless: true,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  webServer: shouldManageServer ? {
    command: 'node ../api/dist/index.js',
    url: `${baseURL}/health`,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      PORT: '3737',
      ADMIN_PASSWORD: '',
      DISCOGENIUS_DISABLE_DOWNLOADS: '1',
      DISCOGENIUS_DISABLE_MONITORING: '1',
      DISCOGENIUS_DISABLE_SCHEDULER: '1',
    },
  } : undefined,
});


