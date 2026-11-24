import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client';

/**
 * The Research Store's own migrations (ADR 0115). Kept out of the package
 * index, like `migrate.ts`, so the web build never resolves the folder.
 */
export const RESEARCH_MIGRATIONS_FOLDER = fileURLToPath(
  new URL('../research-migrations', import.meta.url),
);

/** Applies the Research Store's own migrations. Requires its owner connection. */
export async function runResearchMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: RESEARCH_MIGRATIONS_FOLDER });
}
