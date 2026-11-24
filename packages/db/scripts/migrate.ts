import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import { runMigrations } from '../src/migrate';
import { runResearchMigrations } from '../src/research-migrate';

const { DATABASE_URL } = loadOwnerDbEnv();
const { db, close } = createDb(DATABASE_URL, { max: 1 });
try {
  await runMigrations(db);
  process.stdout.write('Migrations applied.\n');
} finally {
  await close();
}

// The Research Store (ADR 0115) has its own migrations, applied when configured.
const researchUrl = process.env.RESEARCH_DATABASE_URL;
if (researchUrl) {
  const research = createDb(researchUrl, { max: 1 });
  try {
    await runResearchMigrations(research.db);
    process.stdout.write('Research Store migrations applied.\n');
  } finally {
    await research.close();
  }
}
