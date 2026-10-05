/**
 * Prepares a load-test environment (load/README.md): signs up N accounts through
 * the app's own API, marks their email verified, and gives each one M saved
 * strategies. Writes the accounts to load/users.json for k6 to sign in with.
 *
 *   APP_URL=http://localhost:3000 DATABASE_URL=… \
 *     pnpm --filter @tm/db load:seed [users] [strategiesPerUser]
 *
 * Never run this against production: it creates accounts.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createDefinition } from '@tm/domain';
import { eq, sql } from 'drizzle-orm';
import { createDb } from '../src/client';
import { loadOwnerDbEnv } from '../src/env';
import { users } from '../src/schema';

const PASSWORD = 'load-test-password-1234';

async function main(): Promise<void> {
  const appUrl = process.env.APP_URL ?? 'http://localhost:3000';
  if (/\bprod\b/i.test(appUrl)) throw new Error('refusing to seed a production URL');
  const count = Number(process.argv[2] ?? '20');
  const perUser = Number(process.argv[3] ?? '5');
  const env = loadOwnerDbEnv();
  const { db, close } = createDb(env.DATABASE_URL, { max: 1 });
  const stamp = Date.now().toString(36);
  const accounts: { email: string; password: string }[] = [];
  try {
    for (let i = 0; i < count; i += 1) {
      const email = `load-${stamp}-${i}@example.test`;
      const signUp = await fetch(`${appUrl}/api/auth/sign-up/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: appUrl },
        body: JSON.stringify({ name: `Load ${i}`, email, password: PASSWORD }),
      });
      if (!signUp.ok) {
        throw new Error(
          `sign-up failed for ${email}: ${signUp.status} ${await signUp.text()}. ` +
            'Set SIGNUP_MODE=open on the server for load testing.',
        );
      }
      await db.update(users).set({ emailVerified: true }).where(eq(users.email, email));
      const signIn = await fetch(`${appUrl}/api/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: appUrl },
        body: JSON.stringify({ email, password: PASSWORD }),
      });
      if (!signIn.ok) throw new Error(`sign-in failed for ${email}: ${signIn.status}`);
      const cookie = (signIn.headers.getSetCookie?.() ?? []).map((c) => c.split(';')[0]).join('; ');
      for (let s = 0; s < perUser; s += 1) {
        const res = await fetch(`${appUrl}/api/v1/strategies`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', origin: appUrl, cookie },
          body: JSON.stringify({
            name: `Load strategy ${s + 1}`,
            definition: createDefinition(),
          }),
        });
        if (!res.ok) throw new Error(`strategy ${s} failed for ${email}: ${res.status}`);
      }
      accounts.push({ email, password: PASSWORD });
      process.stdout.write(`${email} ready with ${perUser} strategies\n`);
    }
    // Load accounts get the dev plan so plan limits do not shape the measurement.
    await db.execute(sql`
      update entitlement set plan_code = 'dev'
       where user_id in (select id from "user" where email like ${`load-${stamp}-%`})`);
    const out = resolve(import.meta.dirname, '../../../load/users.json');
    await mkdir(dirname(out), { recursive: true });
    await writeFile(out, `${JSON.stringify(accounts, null, 2)}\n`);
    process.stdout.write(`\n${accounts.length} accounts written to ${out}\n`);
  } finally {
    await close();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
