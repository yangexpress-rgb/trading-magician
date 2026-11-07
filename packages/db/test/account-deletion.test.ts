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
      fields: { keyId: 'PKTEST', secretKey: 'z'.repeat(40) },
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

  it('removes custom REST feed data and settings (review M4)', async () => {
    const userId = await seedUser('feeds@example.test');
    const config = { baseUrl: 'https://api.example.com/v1', auth: { type: 'none' } };
    const [feed] = await t.ownerSql`
      insert into data_feed_connection (user_id, name, provider, asset_classes, config)
      values (${userId}, 'My JSON feed', 'custom_rest', '{stock}', ${t.ownerSql.json(config)})
      returning id`;
    await t.ownerSql`
      insert into custom_feed_test (user_id, config, digest, symbol, status, result)
      values (${userId}, ${t.ownerSql.json(config)}, 'd1', 'SPY', 'succeeded',
              ${t.ownerSql.json({ sample: 'provider answer' })})`;
    await t.ownerSql`
      insert into custom_feed_cache (user_id, feed_id, kind, symbol, payload)
      values (${userId}, ${feed!.id}, 'quote', 'SPY', ${t.ownerSql.json({ last: 1 })})`;
    await t.ownerSql`
      insert into custom_feed_usage (user_id, feed_id, period, window_start, count)
      values (${userId}, ${feed!.id}, 'day', now(), 3)`;
    await markDeleted(userId, 31);

    expect(await purgeDeletedAccounts(t.worker.db)).toBe(1);

    expect(await count('custom_feed_test', userId)).toBe(0);
    expect(await count('custom_feed_cache', userId)).toBe(0);
    expect(await count('custom_feed_usage', userId)).toBe(0);
    const [kept] =
      await t.ownerSql`select name, config from data_feed_connection where id = ${feed!.id}`;
    expect(kept).toEqual({ name: 'Deleted feed', config: {} });
  });

  it('knows what to do with every table that holds a user id', async () => {
    // Each table with a user_id column, and what the purge does with it. A new
    // table fails here until it is added to the purge or listed as kept.
    const handled = new Set([
      // Removed.
      'session',
      'account',
      'credential',
      'backtest_run',
      'backtest_trade',
      'notification',
      'instrument_lookup',
      'price_chart',
      'stock_screen',
      'company_report',
      'custom_feed_test',
      'custom_feed_cache',
      'custom_feed_usage',
      // Kept with names and settings removed.
      'profile',
      'data_feed_connection',
      'broker_connection',
      'trading_account',
      'strategy',
      // Kept: order, execution and audit records (§20 #14), or holding nothing personal.
      'audit_event',
      'order_intent',
      'broker_order',
      'order_event',
      'fill',
      'position_snapshot',
      'trigger_event',
      'scheduled_action',
      'strategy_cycle',
      'strategy_runtime',
      'strategy_version',
      'strategy_instrument',
      'strategy_status_change',
      'execution_control',
      'execution_incident',
      'paper_order',
      'paper_position',
      'paper_update',
      'broker_sync',
      'account_valuation',
      'book_valuation',
      'data_route',
      'entitlement',
      'subscription',
      'billing_event',
      'platform_admin',
    ]);
    const rows = await t.ownerSql`
      select distinct table_name from information_schema.columns
       where table_schema = 'public' and column_name = 'user_id'`;
    const unhandled = rows.map((r) => r.table_name as string).filter((n) => !handled.has(n));
    expect(unhandled).toEqual([]);
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
