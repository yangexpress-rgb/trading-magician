/**
 * Mints invite codes for the controlled launch (ADR 0026):
 *
 *   pnpm --filter @tm/db invites:mint 5 "first testers"
 *   pnpm --filter @tm/db invites:list
 *   pnpm --filter @tm/db invites:release ABCD-EFGH-JKLM-NPQR "sign-up email bounced"
 *
 * Codes are printed once and only their hashes are stored, so a lost code
 * cannot be recovered; mint another. Minting and releasing each write an
 * operator audit event with the count and note, never a code (deviation D6).
 * Needs the owner connection (DATABASE_URL).
 */
import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import { listInvites, mintInvites, releaseInviteAsOperator } from '../src/invites';

async function main(): Promise<void> {
  const env = loadOwnerDbEnv();
  const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
  try {
    const [command, ...rest] = process.argv.slice(2);
    if (command === 'list') {
      const rows = await listInvites(db);
      const claimed = rows.filter((r) => r.claimedAt !== null).length;
      process.stdout.write(`${rows.length} invites, ${claimed} claimed\n`);
      for (const row of rows) {
        const state = row.claimedAt
          ? `claimed ${row.claimedAt.toISOString()}`
          : row.expiresAt && row.expiresAt <= new Date()
            ? 'expired'
            : 'open';
        const code = row.codeHint ? `${row.codeHint}-…  ` : '';
        process.stdout.write(`  ${code}${state}${row.note ? ` — ${row.note}` : ''}\n`);
      }
      return;
    }
    if (command === 'mint') {
      const count = Number(rest[0] ?? '1');
      if (!Number.isInteger(count) || count < 1 || count > 50) {
        throw new Error('mint takes a count between 1 and 50');
      }
      const note = rest[1];
      const codes = await mintInvites(db, count, note ? { note } : {});
      process.stdout.write(`Minted ${codes.length} invite codes. Copy them now:\n`);
      for (const code of codes) process.stdout.write(`  ${code}\n`);
      return;
    }
    if (command === 'release') {
      const code = rest[0];
      if (!code) throw new Error('release takes the code to free');
      const note = rest[1];
      const { released } = await releaseInviteAsOperator(db, code, note ? { note } : {});
      process.stdout.write(
        released
          ? 'Released: that code can be used again.\n'
          : 'Nothing released: that code is unknown, unclaimed, or already used by an account.\n',
      );
      return;
    }
    throw new Error(
      'usage: invites.ts mint <count> [note] | invites.ts list | invites.ts release <code> [note]',
    );
  } finally {
    await close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
