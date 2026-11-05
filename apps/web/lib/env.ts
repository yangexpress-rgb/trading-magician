import { logLevel, nodeEnv, parseEnv } from '@tm/config';
import { z } from 'zod';

export function loadWebEnv(source: Record<string, string | undefined> = process.env) {
  return parseEnv(
    {
      NODE_ENV: nodeEnv,
      LOG_LEVEL: logLevel,
      APP_URL: z.string().url().default('http://localhost:3000'),
    },
    source,
  );
}
