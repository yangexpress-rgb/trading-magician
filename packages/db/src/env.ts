import { parseEnv } from '@tm/config';
import { z } from 'zod';

const pgUrl = z.string().regex(/^postgres(ql)?:\/\//, 'must be a postgres:// URL');

/** Owner connection: migrations and seeding only. */
export const loadOwnerDbEnv = (source?: Record<string, string | undefined>) =>
  parseEnv({ DATABASE_URL: pgUrl }, source);

/** Runtime connections, one per database role. */
export const loadRuntimeDbEnv = (source?: Record<string, string | undefined>) =>
  parseEnv({ DATABASE_APP_URL: pgUrl, DATABASE_AUTH_URL: pgUrl }, source);
