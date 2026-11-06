import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import { seedReferenceData } from '../src/seed';

const { DATABASE_URL } = loadOwnerDbEnv();
const { db, close } = createDb(DATABASE_URL, { max: 1 });
try {
  const seeded = await seedReferenceData(db);
  process.stdout.write(
    seeded ? 'Demo reference data seeded.\n' : 'No reference data to seed (demo data is off).\n',
  );
} finally {
  await close();
}
