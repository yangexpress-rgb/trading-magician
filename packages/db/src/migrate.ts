import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client';
import { seedStrategyLibrary } from './library-seed';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies pending migrations, then registers the Strategy Library seed
 * catalogue if it is not there yet (or its missing tail), so its numbers are
 * issued before anyone can register (ADR 0051, ADR 0055). A new library is
 * moved to convention v2 as it is seeded; an existing v1 library is
 * renumbered only by `library:renumber-v2`. Requires the owner connection.
 */
export async function runMigrations(
  db: Database,
  options: { renumberFreshLibrary?: boolean | undefined } = {},
): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await seedStrategyLibrary(db, { renumberFresh: options.renumberFreshLibrary });
}
