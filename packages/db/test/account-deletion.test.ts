import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Transaction } from '../src/client';
import { prepareAccountDeletion, purgeDeletedAccounts } from '../src/account-deletion';
import { createCredential } from '../src/credentials';
import { notify } from '../src/notifications';
import { provisionWorkspace } from '../src/provision';
import { sessions, users } from '../src/schema';
import { generateCredentialKeyPair } from '../src/sealed';
import { createStrategy } from '../src/strategies';
import { withTenant } from '../src/tenant';
import { createTestDatabase, type TestDatabase } from './harness';

let t: TestDatabase;
const keys = generateCredentialKeyPair();

function pgCode(error: unknown): string | undefined {
  const e = error as { code?: string; cause?: { code?: string } };
  return e.code ?? e.cause?.code;
}

const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

/** A user with a workspace, a strategy, a stored key, a notification and a session. */
async function seedUser(email: string): Promise<string> {
  const [row] = await t.auth.db
    .insert(users)
    .values({ name: 'Jane Trader', email })
    .returning({ id: users.id });
  const userId = row!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'Jane' });
  await as(userId, async (tx) => {
    await createStrategy(tx, userId, { name: 'My secret plan', description: 'Mine', tags: ['x'] });
    await createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: 'Jane key',
      fields: { keyId: 'PKTESTKEYID00007Q2A', secretKey: 'very-secret-value-0123456789abcdefXYZ9' },
      publicKey: keys.publicKey,
    });
    await notify(tx, { userId, kind: 'filled', title: 'Bought 10 ZTSTA' });
    await prepareAccountDeletion(tx, userId);
  });
  await t.auth.db.insert(sessions).values({
    userId,
    token: `token-${userId}`,
    expiresAt: new Date(Date.now() + 86_400_000),
  });
  return userId;
}

async function markDeleted(userId: string, daysAgo: number): Promise<void> {
  await t.ownerSql`update "user" set deleted_at = now() - make_interval(days => ${daysAgo}) where id = ${userId}`;
}

const count = async (table: string, userId: string) =>
  Number(
    (
      await t.ownerSql.unsafe(`select count(*)::int as n from "${table}" where user_id = $1`, [
        userId,
      ])
    )[0]!.n,
  );

beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('account purge (design v1.1 D1)', () => {
  it('purges after 30 days, keeping strategies and the audit trail without names', async () => {
    const old = await seedUser('old@example.test');
    const recent = await seedUser('recent@example.test');
    await markDeleted(old, 31);
    await markDeleted(recent, 5);

    expect(await purgeDeletedAccounts(t.worker.db)).toBe(1);

    const [u] =
      await t.ownerSql`select name, email, image, email_verified, purged_at from "user" where id = ${old}`;
    expect(u).toMatchObject({
      name: 'Deleted account',
      email: `deleted-${old}@deleted.invalid`,
      image: null,
      email_verified: false,
    });
    expect(u!.purged_at).not.toBeNull();
    expect(await count('session', old)).toBe(0);
    expect(await count('credential', old)).toBe(0);
    expect(await count('notification', old)).toBe(0);
    const strategies =
      await t.ownerSql`select name, description, tags from strategy where user_id = ${old}`;
    expect(strategies).toEqual([{ name: 'Deleted strategy', description: '', tags: [] }]);
    const [profile] = await t.ownerSql`select display_name from profile where user_id = ${old}`;
    expect(profile!.display_name).toBe('Deleted account');
    const actions = (
      await t.ownerSql`select action from audit_event where user_id = ${old} order by occurred_at`
    ).map((r) => r.action);
    expect(actions).toContain('account.deleted');
    expect(actions).toContain('credential.created');
    expect(actions).toContain('account.purged');

    // Deleted only 5 days ago: untouched.
    const [r] = await t.ownerSql`select email, purged_at from "user" where id = ${recent}`;
    expect(r).toEqual({ email: 'recent@example.test', purged_at: null });
    expect(await count('credential', recent)).toBe(1);
    expect(await count('session', recent)).toBe(1);

    // Running again purges nothing more.
    expect(await purgeDeletedAccounts(t.worker.db)).toBe(0);
  });

  it('refuses a window shorter than 30 days, and only the worker may purge', async () => {
    await expect(t.worker.db.execute(sql`select purge_deleted_accounts(7, 10)`)).rejects.toSatisfy(
      (e) => pgCode(e) === '22023',
    );
    await expect(t.appSql`select purge_deleted_accounts(30, 10)`).rejects.toSatisfy(
      (e) => pgCode(e) === '42501',
    );
  });

  it('leaves accounts that are not deleted out of reach', async () => {
    const [row] = await t.auth.db
      .insert(users)
      .values({ name: 'Active', email: 'active@example.test' })
      .returning({ id: users.id });
    await provisionWorkspace(t.app.db, { userId: row!.id, displayName: 'Active' });
    await purgeDeletedAccounts(t.worker.db);
    const [u] = await t.auth.db.select().from(users).where(eq(users.id, row!.id));
    expect(u!.name).toBe('Active');
  });
});
