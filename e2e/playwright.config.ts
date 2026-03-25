import { defineConfig } from '@playwright/test';

const e2ePort = process.env.E2E_PORT || '3737';
const baseURL = process.env.BASE_URL || `http://127.0.0.1:${e2ePort}`;
const shouldManageServer = !process.env.BASE_URL;
const baseUrlObject = new URL(baseURL);
const webServerPort = baseUrlObject.port || (baseUrlObject.protocol === 'https:' ? '443' : '80');

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
    reuseExistingServer: false,
    env: {
      ...process.env,
      PORT: webServerPort,
      ADMIN_PASSWORD: '',
      DISCOGENIUS_PROVIDER_AUTH_MODE: 'mock',
      DISCOGENIUS_PROVIDER_AUTH_USERNAME: 'discogenius-e2e',
      DISCOGENIUS_DISABLE_DOWNLOADS: '1',
      DISCOGENIUS_DISABLE_MONITORING: '1',
      DISCOGENIUS_DISABLE_SCHEDULER: '1',
    },
  } : undefined,
});


