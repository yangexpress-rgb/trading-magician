import 'server-only';
import { logLevel, nodeEnv, parseEnv } from '@tm/config';
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
    },
    source,
  );
  if (env.NODE_ENV === 'production' && env.MAIL_TRANSPORT === 'outbox' && !source.E2E_TEST) {
    throw new Error('MAIL_TRANSPORT=outbox is for development and tests only');
  }
  return env;
}

export type ServerEnv = ReturnType<typeof loadServerEnv>;

let cached: ServerEnv | undefined;
export const serverEnv = (): ServerEnv => (cached ??= loadServerEnv());
