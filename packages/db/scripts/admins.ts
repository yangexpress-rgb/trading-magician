/**
 * Grants or revokes access to the admin page (ADR 0037). Admins can only be
 * made here, with the owner connection, never from the app:
 *
 *   pnpm --filter @tm/db users:grant-admin person@example.com
 *   pnpm --filter @tm/db users:revoke-admin person@example.com
 *
 * Needs DATABASE_URL (owner) and DATABASE_AUTH_URL (to find the account), as
 * on the web service. Each change writes an admin.granted or admin.revoked
 * operator audit event.
 */
import { parseEnv } from '@tm/config';
import { z } from 'zod';
import { setPlatformAdmin } from '../src/admin';
import { createDb } from '../src/client';

async function main(): Promise<void> {
  const env = parseEnv({ DATABASE_URL: z.string().min(1), DATABASE_AUTH_URL: z.string().min(1) });
  const [command, email] = process.argv.slice(2);
  if ((command !== 'grant' && command !== 'revoke') || !email?.includes('@')) {
    throw new Error('usage: admins.ts grant|revoke <email>');
  }
  const owner = createDb(env.DATABASE_URL, { max: 1 });
  const auth = createDb(env.DATABASE_AUTH_URL, { max: 1 });
  try {
    const result = await setPlatformAdmin(owner.db, auth.db, email, command === 'grant');
    if (!result) {
      process.stderr.write('No account with that email.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(
      command === 'grant'
        ? result.changed
          ? `${email} is now an admin.\n`
          : `${email} was already an admin.\n`
        : result.changed
          ? `${email} is no longer an admin.\n`
          : `${email} was not an admin.\n`,
    );
  } finally {
    await Promise.all([owner.close(), auth.close()]);
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
