import { logLevel, nodeEnv, parseEnv, pemKey } from '@tm/config';
import { z } from 'zod';

const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL');

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env) {
  const env = parseEnv(
    {
      NODE_ENV: nodeEnv,
      LOG_LEVEL: logLevel,
      WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
      /**
       * The worker's login: tm_app plus tm_secrets, so it can read sealed
       * credentials (ADR 0015). Falls back to DATABASE_APP_URL, in which case
       * strategies using a stored credential cannot connect.
       */
      DATABASE_WORKER_URL: pgUrl.optional(),
      /** The tm_app login. Without either URL the worker serves health checks only. */
      DATABASE_APP_URL: pgUrl.optional(),
      /**
       * DEVELOPMENT ONLY: opens sealed provider credentials with a private key
       * held in the environment. Refused on Railway; staging and production use
       * CREDENTIALS_KMS_KEY_ID instead (ADR 0035).
       */
      CREDENTIALS_PRIVATE_KEY: pemKey('PRIVATE KEY').optional(),
      /**
       * The AWS KMS key (ARN) whose private half unwraps sealed credentials
       * (ADR 0035). The key never leaves KMS; the worker's AWS credentials need
       * only kms:Decrypt and kms:GetPublicKey on this one key.
       */
      CREDENTIALS_KMS_KEY_ID: z
        .string()
        .regex(/^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/, 'must be a KMS key ARN')
        .optional(),
      AWS_REGION: z.string().max(40).optional(),
      BACKTEST_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
      /** How often running paper strategies are claimed and stepped. */
      RUNTIME_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
      /** How often due data-feed checks are looked for. */
      FEED_CHECK_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(2000),
      /** How often each trading account is valued (ADR 0020). */
      VALUATION_EVERY_SEC: z.coerce.number().int().min(10).max(3600).default(300),
      /**
       * Development and tests only: the paper runtimes' clock starts at this
       * instant and then runs in real time, so the simulated market can be open
       * whenever a test runs. Never set in production.
       */
      PAPER_CLOCK_START: z.iso.datetime({ offset: true }).optional(),
      /**
       * Stripe, test mode only (ADR 0023): with it the worker re-reads each
       * subscription hourly in case a webhook was missed.
       */
      STRIPE_SECRET_KEY: z
        .string()
        .regex(/^(sk|rk)_test_[A-Za-z0-9]+$/, 'must be a Stripe test-mode key')
        .optional(),
      /** Sends worker errors to Sentry (ADR 0025). Optional. */
      SENTRY_DSN: z.string().url().optional(),
      /** Names the environment in error reports; Railway sets RAILWAY_ENVIRONMENT_NAME. */
      SENTRY_ENVIRONMENT: z.string().max(40).optional(),
      RAILWAY_ENVIRONMENT_NAME: z.string().max(40).optional(),
      RAILWAY_GIT_COMMIT_SHA: z.string().max(64).optional(),
      /** How often the worker marks itself alive for the system health check. */
      HEARTBEAT_MS: z.coerce.number().int().min(1000).max(60_000).default(30_000),
      /** Tests only: plans' prices are the billing stand-in's made-up ones (ADR 0023). */
      BILLING_FAKE: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
      /** Tests only: SEC EDGAR calls go to an in-process fake with made-up companies. */
      SEC_FAKE: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
      /** Tests only: custom REST feeds reach an in-process fake JSON API (ADR 0041). */
      CUSTOM_REST_FAKE: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
      /** CBOE's index history folder (v1.2 item 5); the public CDN when unset. */
      CBOE_HISTORY_URL: z.string().url().startsWith('https://').optional(),
      /** FRED's CSV download, the VIX fallback (VIXCLS); FRED's own when unset. */
      FRED_CSV_URL: z.string().url().startsWith('https://').optional(),
      /** CBOE's delayed options quotes folder (ADR 0047); the public CDN when unset. */
      CBOE_OPTIONS_URL: z.string().url().startsWith('https://').optional(),
      /** Tests only: CBOE's options files come from an in-process fake (ADR 0047). */
      CBOE_OPTIONS_FAKE: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
      /** Records option chains daily (ADR 0047); 'off' stops the recording and rebuild. */
      OPTIONS_RECORDING: z.enum(['on', 'off']).default('on'),
      /** Days of options history kept (brief §3.5). */
      OPTIONS_HISTORY_DAYS: z.coerce.number().int().min(5).max(3650).default(400),
      /**
       * The app's own Alpaca paper key for options data (ADR 0047): the
       * underlying's daily close and the history rebuild from option bars. The
       * recording is shared by every tenant, so it can't use anyone's own key.
       */
      OPTIONS_ALPACA_KEY_ID: z.string().min(8).max(100).optional(),
      OPTIONS_ALPACA_SECRET_KEY: z.string().min(8).max(200).optional(),
      /** Tests only: CBOE's index history comes from an in-process fake (v1.2 item 5). */
      CBOE_FAKE: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
      /** Tests only: Alpaca calls go to an in-process fake with made-up symbols. */
      ALPACA_FAKE: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
    },
    source,
  );
  if (env.CREDENTIALS_PRIVATE_KEY && env.CREDENTIALS_KMS_KEY_ID) {
    throw new Error('Set CREDENTIALS_KMS_KEY_ID or CREDENTIALS_PRIVATE_KEY, not both');
  }
  if (env.CREDENTIALS_PRIVATE_KEY && env.RAILWAY_ENVIRONMENT_NAME) {
    throw new Error(
      'CREDENTIALS_PRIVATE_KEY is for local development only; deployments use CREDENTIALS_KMS_KEY_ID (ADR 0035)',
    );
  }
  if (env.NODE_ENV === 'production' && env.PAPER_CLOCK_START && !source.E2E_TEST) {
    throw new Error('PAPER_CLOCK_START is for development and tests only');
  }
  if (env.NODE_ENV === 'production' && env.BILLING_FAKE && !source.E2E_TEST) {
    throw new Error('BILLING_FAKE is for tests only');
  }
  if (env.NODE_ENV === 'production' && env.ALPACA_FAKE && !source.E2E_TEST) {
    throw new Error('ALPACA_FAKE is for tests only');
  }
  if (env.NODE_ENV === 'production' && env.CUSTOM_REST_FAKE && !source.E2E_TEST) {
    throw new Error('CUSTOM_REST_FAKE is for tests only');
  }
  if (env.NODE_ENV === 'production' && env.CBOE_OPTIONS_FAKE && !source.E2E_TEST) {
    throw new Error('CBOE_OPTIONS_FAKE is for tests only');
  }
  if (!env.OPTIONS_ALPACA_KEY_ID !== !env.OPTIONS_ALPACA_SECRET_KEY) {
    throw new Error('Set both OPTIONS_ALPACA_KEY_ID and OPTIONS_ALPACA_SECRET_KEY, or neither');
  }
  if (env.NODE_ENV === 'production' && env.CBOE_FAKE && !source.E2E_TEST) {
    throw new Error('CBOE_FAKE is for tests only');
  }
  if (env.NODE_ENV === 'production' && env.SEC_FAKE && !source.E2E_TEST) {
    throw new Error('SEC_FAKE is for tests only');
  }
  return env;
}

/** A clock that starts at `start` and advances with real time. */
export function shiftedClock(start: string, real: () => number = Date.now): () => Date {
  const offset = new Date(start).getTime() - real();
  return () => new Date(real() + offset);
}
