/**
 * Resets someone's password when the app sends no email (EMAIL_VERIFICATION=off,
 * ADR 0036). Run it where the web service's database URLs are set, for example
 * on Railway:
 *
 *   railway ssh -s web -- sh -c 'cd /app && pnpm --filter @tm/web users:reset-password person@example.com'
 *
 * It prints a temporary password once. Give it to the person over a channel
 * you trust; they sign in with it and change it in Settings › Security. Their
 * other sessions are signed out, and the reset is audited in their trail.
 */
import { randomBytes } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { createDb, resetPasswordAsOperator } from '@tm/db';

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const email = process.argv[2];
  if (!email || !email.includes('@')) throw new Error('usage: users:reset-password <email>');
  const auth = createDb(need('DATABASE_AUTH_URL'), { max: 1 });
  const app = createDb(need('DATABASE_APP_URL'), { max: 1 });
  try {
    // 20 characters from a 32-letter alphabet without look-alikes: about 100 bits.
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789ab';
    const password = Array.from(randomBytes(20), (b) => alphabet[b % 32]).join('');
    const result = await resetPasswordAsOperator(
      auth.db,
      app.db,
      email,
      await hashPassword(password),
    );
    if (!result) {
      process.stderr.write('No account with that email.\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Temporary password (shown once): ${password}\n`);
  } finally {
    await Promise.all([auth.close(), app.close()]);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
