import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';
import { ADMIN_PASSWORD, AUTH_FILE } from './e2e/auth';

/**
 * Smoke test: boots the API (mock LinkTap, throwaway SQLite) and the Vite dev server on their own
 * ports, then screenshots every page. Run with `pnpm --filter @hoseidon/web e2e`.
 */
const API_PORT = 8797;
const WEB_PORT = 5179;
const TZ = 'America/New_York';
// The seed builds wall times with Date, so the runner uses the same zone as the server.
process.env.TZ = TZ;

export default defineConfig({
  testDir: 'e2e',
  outputDir: 'e2e/.results',
  fullyParallel: false,
  workers: 1,
  reporter: process.env.CI
    ? [['list'], ['html', { open: 'never', outputFolder: 'e2e/.report' }]]
    : 'list',
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    timezoneId: TZ,
    locale: 'en-US',
    serviceWorkers: 'block',
  },
  projects: [
    { name: 'setup', testMatch: /auth.setup.ts/ },
    {
      name: 'app',
      testIgnore: /auth.setup.ts/,
      dependencies: ['setup'],
      use: { storageState: AUTH_FILE },
    },
  ],
  webServer: [
    {
      command: 'node node_modules/tsx/dist/cli.mjs src/index.ts',
      cwd: '../server',
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      env: {
        PORT: String(API_PORT),
        LINKTAP_MOCK: 'true',
        ADMIN_PASSWORD,
        WEBHOOK_SECRET: 'e2e-webhook-secret',
        DATABASE_PATH: join(tmpdir(), `hoseidon-e2e-${process.pid}.sqlite`),
        WEB_DIST: './no-web-dist',
        TZ,
      },
    },
    {
      command: `node node_modules/vite/bin/vite.js --port ${WEB_PORT} --strictPort`,
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      env: { HOSEIDON_API: `http://localhost:${API_PORT}` },
    },
  ],
});
