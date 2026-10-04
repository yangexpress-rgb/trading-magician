import { logLevel, nodeEnv, parseEnv } from '@tm/config';
import { z } from 'zod';

export function loadWorkerEnv(source: Record<string, string | undefined> = process.env) {
  return parseEnv(
    {
      NODE_ENV: nodeEnv,
      LOG_LEVEL: logLevel,
      WORKER_HEALTH_PORT: z.coerce.number().int().min(1).max(65535).default(4001),
    },
    source,
  );
}
