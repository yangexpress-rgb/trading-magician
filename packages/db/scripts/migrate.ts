import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import { runMigrations } from '../src/migrate';

const { DATABASE_URL } = loadOwnerDbEnv();
const { db, close } = createDb(DATABASE_URL, { max: 1 });
try {
  await runMigrations(db);
  process.stdout.write('Migrations applied.\n');
} finally {
  await close();
}
