import { generateKeyPairSync } from 'node:crypto';
import { defineConfig, devices } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT ?? 3100);
const WORKER_PORT = PORT + 1001;

// A throwaway credential key pair for this run (ADR 0015): the web server gets
// only the public half, the worker the private half.
const credentialKeys = generateKeyPairSync('rsa', {
  modulusLength: 3072,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

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
  webServer: [
    {
      command: `pnpm exec next start -p ${PORT}`,
      url: `http://localhost:${PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      env: {
        APP_URL: `http://localhost:${PORT}`,
        MAIL_TRANSPORT: 'outbox',
        MAIL_OUTBOX_DIR: '.mail-outbox',
        E2E_TEST: '1',
        CREDENTIALS_PUBLIC_KEY: credentialKeys.publicKey,
      },
    },
    {
      // Runs queued back tests and paper strategies; uses DATABASE_WORKER_URL from the environment.
      command: 'pnpm --filter @tm/worker start',
      url: `http://localhost:${WORKER_PORT}/healthz`,
      reuseExistingServer: !process.env.CI,
      env: {
        WORKER_HEALTH_PORT: String(WORKER_PORT),
        BACKTEST_POLL_MS: '200',
        RUNTIME_POLL_MS: '200',
        FEED_CHECK_POLL_MS: '200',
        // Accounts are valued every 10 seconds rather than 5 minutes, so results show quickly.
        VALUATION_EVERY_SEC: '10',
        // Paper strategies trade in a simulated session that is open while the tests run.
        PAPER_CLOCK_START: '2026-10-06T14:31:00Z',
        // Alpaca calls go to an in-process fake with made-up symbols; no keys or network.
        ALPACA_FAKE: 'true',
        E2E_TEST: '1',
        LOG_LEVEL: 'warn',
        CREDENTIALS_PRIVATE_KEY: credentialKeys.privateKey,
      },
    },
  ],
});
