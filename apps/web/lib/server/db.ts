import 'server-only';
import {
  createDb,
  researchStore,
  researchTx,
  type DbHandle,
  type ResearchStore,
  type ResearchTx,
  type TenantContext,
} from '@tm/db';
import { serverEnv } from './env';

// Reuse pools across hot reloads in development.
const globalForDb = globalThis as unknown as {
  tmAppDb?: DbHandle;
  tmAuthDb?: DbHandle;
  tmResearchDb?: DbHandle;
};

/** Runtime pool for the tm_app role. All tenant data access goes through withTenant(). */
export const appDb = () => (globalForDb.tmAppDb ??= createDb(serverEnv().DATABASE_APP_URL)).db;

/** Pool for the tm_auth role. Only the auth library uses it. */
export const authDb = () =>
  (globalForDb.tmAuthDb ??= createDb(serverEnv().DATABASE_AUTH_URL, { max: 5 })).db;

/**
 * The Research Store (ADR 0115): its own database when RESEARCH_DATABASE_APP_URL
 * is set, otherwise the Core database. Only research pages use it; nothing on
 * the trading path does, so a Research outage never reaches Orders or execution.
 */
export const research = (): ResearchStore => {
  const url = serverEnv().RESEARCH_DATABASE_APP_URL;
  if (!url) return researchStore(appDb());
  return researchStore(appDb(), (globalForDb.tmResearchDb ??= createDb(url, { max: 5 })).db);
};

/** A tenant-scoped runner on the Research Store. */
export const researchFor = (tenant: TenantContext): ResearchTx => researchTx(research(), tenant);
