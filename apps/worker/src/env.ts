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
      /** Opens sealed provider credentials. Only the worker ever holds it. */
      CREDENTIALS_PRIVATE_KEY: pemKey('PRIVATE KEY').optional(),
      BACKTEST_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
      /** How often running paper strategies are claimed and stepped. */
      RUNTIME_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
      /** How often due data-feed checks are looked for. */
      FEED_CHECK_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(2000),
      /**
       * Development and tests only: the paper runtimes' clock starts at this
       * instant and then runs in real time, so the simulated market can be open
       * whenever a test runs. Never set in production.
       */
      PAPER_CLOCK_START: z.iso.datetime({ offset: true }).optional(),
      /** Tests only: Alpaca calls go to an in-process fake with made-up symbols. */
      ALPACA_FAKE: z
        .enum(['true', 'false'])
        .default('false')
        .transform((v) => v === 'true'),
    },
    source,
  );
  if (env.NODE_ENV === 'production' && env.PAPER_CLOCK_START && !source.E2E_TEST) {
    throw new Error('PAPER_CLOCK_START is for development and tests only');
  }
  if (env.NODE_ENV === 'production' && env.ALPACA_FAKE && !source.E2E_TEST) {
    throw new Error('ALPACA_FAKE is for tests only');
  }
  return env;
}

/** A clock that starts at `start` and advances with real time. */
export function shiftedClock(start: string, real: () => number = Date.now): () => Date {
  const offset = new Date(start).getTime() - real();
  return () => new Date(real() + offset);
}
