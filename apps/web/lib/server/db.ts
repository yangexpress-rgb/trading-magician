import 'server-only';
import { createDb, type DbHandle } from '@tm/db';
import { serverEnv } from './env';

// Reuse pools across hot reloads in development.
const globalForDb = globalThis as unknown as { tmAppDb?: DbHandle; tmAuthDb?: DbHandle };

/** Runtime pool for the tm_app role. All tenant data access goes through withTenant(). */
export const appDb = () => (globalForDb.tmAppDb ??= createDb(serverEnv().DATABASE_APP_URL)).db;

/** Pool for the tm_auth role. Only the auth library uses it. */
export const authDb = () =>
  (globalForDb.tmAuthDb ??= createDb(serverEnv().DATABASE_AUTH_URL, { max: 5 })).db;
