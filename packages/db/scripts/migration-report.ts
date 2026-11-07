/**
 * Lists every stored strategy draft and version that reading as schema 2
 * converts (ADR 0049): what changed, every grandfathered Exit-leg stop order
 * and whether each strategy still validates. Read-only:
 *
 *   pnpm --filter @tm/db strategies:migration-report [report.md]
 *
 * Needs the owner connection (DATABASE_URL).
 */
import { writeFileSync } from 'node:fs';
import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import { formatMigrationReport, strategyMigrationReport } from '../src/migration-report';

const { DATABASE_URL } = loadOwnerDbEnv();
const { db, close } = createDb(DATABASE_URL, { max: 1 });
try {
  const report = formatMigrationReport(await strategyMigrationReport(db));
  const file = process.argv[2];
  if (file) {
    writeFileSync(file, report);
    process.stdout.write(`Wrote ${file}\n`);
  } else process.stdout.write(`${report}\n`);
} finally {
  await close();
}
