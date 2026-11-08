/**
 * The Strategy Lab numbering backfill (ADR 0054, brief D9; first written for
 * ADR 0051): links the built seed entries of the Strategy Library to one
 * person's Strategy Lab strategies, matched by name. Dry run by default:
 *
 *   pnpm --filter @tm/db library:link-seed -- --email person@example.com [--apply]
 *
 * Only clear one-to-one matches are applied; ambiguous or missing ones are
 * listed so they can be linked by hand in the builder's Library entry picker.
 * Strategies named "Fixture …" are left out. Each linked strategy then shows
 * the seed entry's number; nothing else is numbered (every other strategy gets
 * its record on its next save). Each link is recorded in the entry's history.
 * Needs the owner connection (DATABASE_URL). Run it before editing the matched
 * strategies, or each gets a record of its own first (which then stays, Not built).
 */
import { sql } from 'drizzle-orm';
import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import { backfillSeedLinks } from '../src/library-lab';
import { users } from '../src/schema';
import { withTenant } from '../src/tenant';

const args = process.argv.slice(2);
const email = args[args.indexOf('--email') + 1];
const apply = args.includes('--apply');
if (!args.includes('--email') || !email) {
  process.stderr.write('Usage: library:link-seed -- --email person@example.com [--apply]\n');
  process.exit(2);
}

const { DATABASE_URL } = loadOwnerDbEnv();
const { db, close } = createDb(DATABASE_URL, { max: 1 });
try {
  const [user] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.email}) = lower(${email})`);
  if (!user) throw new Error(`No account with email ${email}`);
  const rows = await withTenant(db, { userId: user.id }, (tx) =>
    backfillSeedLinks(tx, user.id, { apply }),
  );
  for (const r of rows) {
    const o = r.outcome;
    const line =
      o.kind === 'linked' || o.kind === 'would_link'
        ? `→ ${o.strategyName}${o.kind === 'linked' ? '  (linked)' : ''}`
        : o.kind === 'already_linked'
          ? `already linked${o.strategyName ? ` to ${o.strategyName}` : " (another member's Strategy Lab)"}`
          : o.kind === 'retired'
            ? 'retired; not linked'
            : o.kind === 'ambiguous'
              ? `? several match: ${o.candidates.join(' | ')}`
              : '- no strategy matches; link it by hand';
    process.stdout.write(`${r.registrationNumber}  ${r.name}\n    ${line}\n`);
  }
  if (!apply) process.stdout.write('\nDry run. Add --apply to save the matched links.\n');
} finally {
  await close();
}
