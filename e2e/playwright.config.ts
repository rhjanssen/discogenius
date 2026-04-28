import { defineConfig } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const e2ePort = process.env.E2E_PORT || '3737';
const configuredBaseURL = process.env.BASE_URL;
const baseURL = configuredBaseURL || `http://[::1]:${e2ePort}`;
const shouldManageServer = !configuredBaseURL;
const baseUrlObject = new URL(baseURL);
const webServerPort = baseUrlObject.port || (baseUrlObject.protocol === 'https:' ? '443' : '80');

if (!configuredBaseURL) {
  process.env.BASE_URL = baseURL;
}

const runtimeRoot = shouldManageServer
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'discogenius-e2e-'))
  : '';
const runtimeConfigDir = runtimeRoot ? path.join(runtimeRoot, 'config') : '';
const runtimeDownloadDir = runtimeRoot ? path.join(runtimeRoot, 'downloads') : '';
const runtimeMusicDir = runtimeRoot ? path.join(runtimeRoot, 'library', 'music') : '';
const runtimeAtmosDir = runtimeRoot ? path.join(runtimeRoot, 'library', 'atmos') : '';
const runtimeVideoDir = runtimeRoot ? path.join(runtimeRoot, 'library', 'videos') : '';

if (shouldManageServer) {
  for (const dir of [runtimeConfigDir, runtimeDownloadDir, runtimeMusicDir, runtimeAtmosDir, runtimeVideoDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(
    path.join(runtimeConfigDir, 'config.toml'),
    [
      '[app]',
      'admin_password = ""',
      '',
      '[path]',
      `music_path = ${JSON.stringify(runtimeMusicDir)}`,
      `atmos_path = ${JSON.stringify(runtimeAtmosDir)}`,
      `video_path = ${JSON.stringify(runtimeVideoDir)}`,
      '',
    ].join('\n'),
    'utf-8',
  );
}

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
      DISCOGENIUS_CONFIG_DIR: runtimeConfigDir,
      DB_PATH: path.join(runtimeConfigDir, 'discogenius.e2e.db'),
      DOWNLOAD_PATH: runtimeDownloadDir,
      TIDAL_DL_NG_CONFIG: path.join(runtimeConfigDir, 'tidal_dl_ng-dev'),
      DISCOGENIUS_PROVIDER_AUTH_MODE: 'mock',
      DISCOGENIUS_PROVIDER_AUTH_USERNAME: 'discogenius-e2e',
      DISCOGENIUS_DISABLE_DOWNLOADS: '1',
      DISCOGENIUS_DISABLE_MONITORING: '1',
      DISCOGENIUS_DISABLE_SCHEDULER: '1',
    },
  } : undefined,
});
