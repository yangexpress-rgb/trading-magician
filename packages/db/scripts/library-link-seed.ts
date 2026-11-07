/**
 * Links the built seed entries of the Strategy Library to one person's Strategy
 * Lab strategies, matched by name (ADR 0051). Dry run by default:
 *
 *   pnpm --filter @tm/db library:link-seed -- --email person@example.com [--apply]
 *
 * Only clear one-to-one matches are applied; ambiguous or missing ones are
 * listed so they can be linked by hand in the Library's edit form. Each link
 * is recorded in the entry's history. Needs the owner connection (DATABASE_URL).
 */
import { isNull, sql } from 'drizzle-orm';
import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import { getLibraryEntry, linkLibraryEntry } from '../src/library';
import { matchSeedLinks } from '../src/library-seed';
import { strategies, users } from '../src/schema';
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
  await withTenant(db, { userId: user.id }, async (tx) => {
    const workspace = await tx
      .select({ id: strategies.id, name: strategies.name })
      .from(strategies)
      .where(isNull(strategies.deletedAt));
    for (const m of matchSeedLinks(workspace)) {
      const current = await getLibraryEntry(tx, user.id, m.registrationNumber);
      const label = `${m.registrationNumber}  ${m.name}`;
      if (current?.builtStrategyId) {
        process.stdout.write(`${label}\n    already linked\n`);
        continue;
      }
      if (m.result.kind === 'match') {
        process.stdout.write(
          `${label}\n    → ${m.result.strategyName}${apply ? '  (linked)' : ''}\n`,
        );
        if (apply) {
          await linkLibraryEntry(
            tx,
            user.id,
            m.registrationNumber,
            m.result.strategyId,
            `Linked to the built Strategy Lab strategy "${m.result.strategyName}"`,
          );
        }
      } else if (m.result.kind === 'ambiguous') {
        process.stdout.write(`${label}\n    ? several match: ${m.result.candidates.join(' | ')}\n`);
      } else process.stdout.write(`${label}\n    - no strategy matches; link it by hand\n`);
    }
  });
  if (!apply) process.stdout.write('\nDry run. Add --apply to save the matched links.\n');
} finally {
  await close();
}
