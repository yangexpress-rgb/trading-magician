import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);

/**
 * End-to-end tests run against a production build (`pnpm build` first) with
 * MAIL_TRANSPORT=outbox, so emails land as JSON files the tests can read.
 * Database URLs come from the environment; see README "End-to-end tests".
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Lets a pre-installed browser be used instead of `playwright install`.
        ...(process.env.PW_CHROMIUM_PATH
          ? { launchOptions: { executablePath: process.env.PW_CHROMIUM_PATH } }
          : {}),
      },
    },
  ],
  webServer: {
    command: `pnpm exec next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/health`,
    reuseExistingServer: !process.env.CI,
    env: {
      APP_URL: `http://localhost:${PORT}`,
      MAIL_TRANSPORT: 'outbox',
      MAIL_OUTBOX_DIR: '.mail-outbox',
      E2E_TEST: '1',
    },
  },
});
