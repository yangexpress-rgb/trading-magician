import { logLevel, nodeEnv, parseEnv } from '@tm/config';
import { z } from 'zod';

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env) {
  const env = parseEnv(
    {
      NODE_ENV: nodeEnv,
      LOG_LEVEL: logLevel,
      WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
      /** The tm_app login. Without it the worker serves health checks only. */
      DATABASE_APP_URL: z
        .string()
        .regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL')
        .optional(),
      BACKTEST_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
      /** How often running paper strategies are claimed and stepped. */
      RUNTIME_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(1000),
      /**
       * Development and tests only: the paper runtimes' clock starts at this
       * instant and then runs in real time, so the simulated market can be open
       * whenever a test runs. Never set in production.
       */
      PAPER_CLOCK_START: z.iso.datetime({ offset: true }).optional(),
    },
    source,
  );
  if (env.NODE_ENV === 'production' && env.PAPER_CLOCK_START && !source.E2E_TEST) {
    throw new Error('PAPER_CLOCK_START is for development and tests only');
  }
  return env;
}

/** A clock that starts at `start` and advances with real time. */
export function shiftedClock(start: string, real: () => number = Date.now): () => Date {
  const offset = new Date(start).getTime() - real();
  return () => new Date(real() + offset);
}
