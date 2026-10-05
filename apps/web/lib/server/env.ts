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
    },
    source,
  );
  if (source.CREDENTIALS_PRIVATE_KEY) {
    throw new Error(
      'CREDENTIALS_PRIVATE_KEY belongs to the worker only; remove it from the web app',
    );
  }
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'outbox' && !source.E2E_TEST) {
    throw new Error('MAIL_TRANSPORT=outbox is for development and tests only');
  }
  return env;
}

export type ServerEnv = ReturnType<typeof loadServerEnv>;

let cached: ServerEnv | undefined;
export const serverEnv = (): ServerEnv => (cached ??= loadServerEnv());
