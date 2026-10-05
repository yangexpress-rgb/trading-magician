import 'server-only';
import { logLevel, nodeEnv, parseEnv, pemKey } from '@tm/config';
import { z } from 'zod';

const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL');

export function loadServerEnv(source: Record<string, string | undefined> = process.env) {
  const env = parseEnv(
    {
      NODE_ENV: nodeEnv,
      LOG_LEVEL: logLevel,
      APP_URL: z.string().url().default('http://localhost:3000'),
      BETTER_AUTH_SECRET: z.string().min(32),
      DATABASE_APP_URL: pgUrl,
      DATABASE_AUTH_URL: pgUrl,
      MAIL_TRANSPORT: z.enum(['smtp', 'outbox']).default('smtp'),
      MAIL_FROM: z.string().default('Trading Magician <no-reply@localhost>'),
      SMTP_URL: z.string().url().default('smtp://localhost:1025'),
      MAIL_OUTBOX_DIR: z.string().default('.mail-outbox'),
      /**
       * Seals provider credentials (ADR 0015). Public half only: the web app can
       * store a secret but never read one back. Without it, saving is refused.
       */
      CREDENTIALS_PUBLIC_KEY: pemKey('PUBLIC KEY').optional(),
      /**
       * Starts new workspaces on this plan instead of the catalog's default
       * (ADR 0022). For tests and staging; leave unset in production.
       */
      SIGNUP_PLAN: z
        .string()
        .regex(/^[a-z0-9_-]{1,40}$/)
        .optional(),
      /** Stripe Billing, test mode only (ADR 0023). Without it, checkout is unavailable. */
      STRIPE_SECRET_KEY: z
        .string()
        .regex(/^(sk|rk)_test_[A-Za-z0-9]+$/, 'must be a Stripe test-mode key')
        .optional(),
      STRIPE_WEBHOOK_SECRET: z.string().min(10).optional(),
      /** Sends server errors to Sentry (ADR 0025). Optional. */
      SENTRY_DSN: z.string().url().optional(),
      /** Names the environment in error reports; Railway sets RAILWAY_ENVIRONMENT_NAME. */
      SENTRY_ENVIRONMENT: z.string().max(40).optional(),
      RAILWAY_ENVIRONMENT_NAME: z.string().max(40).optional(),
      RAILWAY_GIT_COMMIT_SHA: z.string().max(64).optional(),
      /** Tests only: an in-process stand-in for Stripe with its own checkout and portal pages. */
      BILLING_FAKE: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
    },
    source,
  );
  if (source.CREDENTIALS_PRIVATE_KEY) {
    throw new Error(
      'CREDENTIALS_PRIVATE_KEY belongs to the worker only; remove it from the web app',
    );
  }
  if (env.NODE_ENV === 'production' && env.BILLING_FAKE && !source.E2E_TEST) {
    throw new Error('BILLING_FAKE is for tests only');
  }
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'outbox' && !source.E2E_TEST) {
    throw new Error('MAIL_TRANSPORT=outbox is for development and tests only');
  }
  return env;
}

export type ServerEnv = ReturnType<typeof loadServerEnv>;

let cached: ServerEnv | undefined;
export const serverEnv = (): ServerEnv => (cached ??= loadServerEnv());
