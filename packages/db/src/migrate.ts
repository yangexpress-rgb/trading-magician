import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client';
import { seedStrategyLibrary } from './library-seed';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies pending migrations, then registers the Strategy Library seed
 * catalogue if it is not there yet, so its numbers are issued before anyone
 * can register (ADR 0051). Requires the owner connection.
 */
export async function runMigrations(db: Database): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await seedStrategyLibrary(db);
}
