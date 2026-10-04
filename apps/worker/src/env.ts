import { logLevel, nodeEnv, parseEnv } from '@tm/config';
import { z } from 'zod';

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env) {
  return parseEnv(
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
    },
    source,
  );
}
