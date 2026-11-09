import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import type { Database } from './client';
import { seedStrategyLibrary } from './library-seed';
import { renumberToTheories } from './library-theory';

export const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * Applies pending migrations, then registers the Strategy Library seed
 * catalogue if it is not there yet (or its missing tail), so its numbers are
 * issued before anyone can register (ADR 0051, ADR 0055). A new library is
 * moved to convention v2 as it is seeded; an existing v1 library is
 * renumbered only by `library:renumber-v2`. A v2 library then becomes
 * theories (convention v3, T numbers; N181) unless `renumberFreshLibrary` is
 * false. Requires the owner connection.
 */
export async function runMigrations(
  db: Database,
  options: { renumberFreshLibrary?: boolean | undefined } = {},
): Promise<void> {
  await migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  await seedStrategyLibrary(db, { renumberFresh: options.renumberFreshLibrary });
  if (options.renumberFreshLibrary !== false) {
    // All or nothing in its own transaction. A refusal leaves the S numbers
    // as they were and is logged, so it never blocks a deploy.
    try {
      const outcome = await renumberToTheories(db);
      if (outcome.kind === 'not_on_v2') {
        process.stderr.write(`Strategy Library: theory numbers not applied: ${outcome.reason}.\n`);
      }
    } catch (error) {
      process.stderr.write(
        `Strategy Library: theory numbers refused, nothing changed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }
}
