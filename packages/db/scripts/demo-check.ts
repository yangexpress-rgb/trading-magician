/**
 * Lists any demo instruments left in this database and whose records still use
 * them (design v1.2 item 10). Read-only:
 *
 *   pnpm --filter @tm/db demo:check
 *   pnpm --filter @tm/db demo:remove-unused   (deletes the ones nothing uses)
 *
 * Needs the owner connection (DATABASE_URL).
 */
import { createDb } from '../src/client';
import { listDemoReferences, removeUnusedDemoData } from '../src/demo-references';
import { loadOwnerDbEnv } from '../src/env';

const { DATABASE_URL } = loadOwnerDbEnv();
const { db, close } = createDb(DATABASE_URL, { max: 1 });
try {
  if (process.argv[2] === 'remove') {
    const removed = await removeUnusedDemoData(db);
    process.stdout.write(`Removed ${removed} unused demo instruments.\n`);
  }
  const { instruments, feeds, references } = await listDemoReferences(db);
  process.stdout.write(`${instruments} demo instruments, ${feeds} demo feeds.\n`);
  if (references.length === 0) {
    process.stdout.write(
      instruments > 0
        ? 'Nothing uses them: remove them with demo:remove-unused.\n'
        : 'Nothing to remove.\n',
    );
  } else {
    process.stdout.write('Still in use, so kept until cleared by hand:\n');
    for (const r of references) {
      const parts = [
        r.strategies.length > 0 ? `strategies: ${r.strategies.join(', ')}` : null,
        r.orders > 0 ? `${r.orders} orders` : null,
        r.positions > 0 ? `${r.positions} positions` : null,
      ].filter(Boolean);
      process.stdout.write(`  ${r.symbol} · ${r.email ?? 'unknown user'} · ${parts.join(' · ')}\n`);
    }
  }
} finally {
  await close();
}
