import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import {
  activeOptionsFeed,
  adminFeedSharing,
  adminSetFeedSharing,
  createCredential,
  createFeed,
  feedScope,
  generateCredentialKeyPair,
  getInstrumentLookup,
  getPriceChart,
  hasOwnFeed,
  loadRouting,
  loadValidationContext,
  openCredential,
  provisionWorkspace,
  requestInstrumentLookup,
  requestPriceChart,
  schema,
  sharedFeeds,
  sharedFeedsInUse,
  usableFundamentalsFeed,
  withTenant,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaProvider } from '../src/alpaca';
import { runInstrumentLookups } from '../src/instrument-lookups';
import { runPriceCharts } from '../src/price-charts';
import type { ProviderRegistry } from '../src/providers';

/**
 * Shared data feeds (N237, ADR 0084): a member with no feed of a kind uses
 * the sharing admin's feeds of that kind. Members see names and providers
 * only; the worker opens the admin's keys in the admin's own tenant.
 */

let t: TestDatabase;
const keys = generateCredentialKeyPair();
/** Tuesday 2026-10-06, 11:00 New York. */
const NOW = new Date('2026-10-06T15:00:00Z');
const fake = new FakeAlpaca({ now: () => NOW });
const providers: ProviderRegistry = {
  alpaca: alpacaProvider({
    fetch: fake.fetch,
    fake: { tradingUrl: FAKE_ALPACA_TRADING_URL, dataUrl: FAKE_ALPACA_DATA_URL },
  }),
};
const quiet = { info: () => undefined, warn: () => undefined };
const opts = { db: undefined as never, providers, privateKey: keys.privateKey, logger: quiet };
let admin: string;
let member: string;
let other: string;

async function newUser(email: string) {
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: email, email })
    .returning({ id: schema.users.id });
  const userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: email });
  // Tests provision a demo feed for everyone; production has none (ADR 0039).
  await withTenant(t.app.db, { userId }, (tx) =>
    tx.execute("delete from data_route; delete from data_feed_connection where provider = 'demo'"),
  );
  return userId;
}

async function addAlpaca(userId: string, keyId: string, secretKey = `secret-for-${keyId}`) {
  await withTenant(t.app.db, { userId }, async (tx) => {
    const credential = await createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: 'Alpaca paper',
      fields: { keyId, secretKey },
      publicKey: keys.publicKey,
    });
    await createFeed(tx, {
      userId,
      name: `Alpaca ${keyId}`,
      provider: 'alpaca',
      credentialId: credential.id,
      assetClasses: ['stock', 'etf'],
    });
  });
}

const asApp = <T>(userId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
  withTenant(t.app.db, { userId }, fn);

beforeAll(async () => {
  t = await createTestDatabase();
  admin = await newUser('admin@example.test');
  member = await newUser('member@example.test');
  other = await newUser('other@example.test');
  await addAlpaca(admin, fake.credentials.keyId, fake.credentials.secretKey);
  await asApp(admin, async (tx) => {
    const credential = await createCredential(tx, {
      userId: admin,
      provider: 'sec',
      label: 'SEC',
      fields: { contactEmail: 'admin@example.test' },
      publicKey: keys.publicKey,
    });
    await createFeed(tx, {
      userId: admin,
      name: 'SEC EDGAR',
      provider: 'sec',
      credentialId: credential.id,
      assetClasses: ['stock'],
    });
    await createFeed(tx, {
      userId: admin,
      name: 'CBOE options',
      provider: 'cboe_options',
      assetClasses: ['stock', 'etf'],
    });
  });
  await addAlpaca(other, 'PKOTHER0000000000001');
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('shared data feeds', () => {
  it('shares nothing until a platform admin exists', async () => {
    expect(await asApp(member, sharedFeeds)).toEqual([]);
    const scope = await feedScope(t.worker.db, member, 'prices');
    expect(scope).toMatchObject({ userId: member, shared: false });
  });

  it("gives a member without feeds the admin's, by name only", async () => {
    await t.ownerSql`insert into platform_admin (user_id) values (${admin})`;
    const shared = await asApp(member, sharedFeeds);
    expect(shared.map((f) => [f.kind, f.provider, f.name]).sort()).toEqual([
      ['company', 'sec', 'SEC EDGAR'],
      ['options', 'cboe_options', 'CBOE options'],
      ['prices', 'alpaca', `Alpaca ${fake.credentials.keyId}`],
    ]);
    expect(Object.keys(shared[0]!).sort()).toEqual(['id', 'kind', 'name', 'provider']);
    // Row-level security still keeps the admin's rows themselves away.
    expect(await asApp(member, (tx) => tx.select().from(schema.dataFeedConnections))).toEqual([]);
    expect((await asApp(member, usableFundamentalsFeed))?.name).toBe('SEC EDGAR');
    expect((await asApp(member, activeOptionsFeed))?.name).toBe('CBOE options');
    const ctx = await asApp(member, (tx) => loadValidationContext(tx));
    expect(ctx.hasFeed('stock', 'quotes')).toBe(true);
    expect(ctx.hasCompanyFeed).toBe(true);
  });

  it("opens the admin's key in the admin's tenant for the worker", async () => {
    const scope = await feedScope(t.worker.db, member, 'prices');
    expect(scope).toMatchObject({ userId: admin, shared: true });
    const opened = await scope.inTenant(async (tx) => {
      const routing = await loadRouting(tx);
      const feed = [...routing.feeds.values()].find((f) => f.provider === 'alpaca')!;
      return openCredential(tx, {
        userId: scope.userId,
        id: feed.credentialRef!,
        privateKey: keys.privateKey,
      });
    });
    expect(opened.fields.keyId).toBe(fake.credentials.keyId);
    expect(await feedScope(t.worker.db, member, 'company')).toMatchObject({ userId: admin });
  });

  it('uses a member’s own feed of a kind instead, kind by kind', async () => {
    expect(await feedScope(t.worker.db, other, 'prices')).toMatchObject({
      userId: other,
      shared: false,
    });
    expect(await feedScope(t.worker.db, other, 'company')).toMatchObject({
      userId: admin,
      shared: true,
    });
    expect(await asApp(other, (tx) => hasOwnFeed(tx, 'prices'))).toBe(true);
    expect((await asApp(other, (tx) => sharedFeedsInUse(tx, 'prices'))).length).toBe(0);
    expect((await asApp(other, (tx) => sharedFeedsInUse(tx, 'company'))).length).toBe(1);
  });

  it("looks up and charts a stock for a member through the admin's feed", async () => {
    const run = { ...opts, db: t.worker.db, now: () => NOW };
    const started = await asApp(member, (tx) =>
      requestInstrumentLookup(tx, { userId: member, symbol: 'ZTSTA' }),
    );
    await runInstrumentLookups(run);
    const found = await asApp(member, (tx) => getInstrumentLookup(tx, started.id));
    expect(found.status).toBe('found');
    const chart = await asApp(member, (tx) =>
      requestPriceChart(tx, {
        userId: member,
        instrumentId: found.instrument!.id,
        range: '1m',
        interval: '1d',
        now: NOW,
      }),
    );
    await runPriceCharts(run);
    const c = await asApp(member, (tx) => getPriceChart(tx, chart.id));
    expect(c).toMatchObject({ status: 'ready', source: `Alpaca ${fake.credentials.keyId}` });
    expect(c.bars!.length).toBeGreaterThan(10);
  });

  it('lets only an admin turn sharing off, and then shares nothing', async () => {
    await expect(asApp(member, (tx) => adminSetFeedSharing(tx, false))).rejects.toThrow();
    expect(await asApp(admin, adminFeedSharing)).toBe(true);
    expect(await asApp(admin, (tx) => adminSetFeedSharing(tx, false))).toBe(true);
    expect(await asApp(admin, adminFeedSharing)).toBe(false);
    expect(await asApp(member, sharedFeeds)).toEqual([]);
    expect(await asApp(member, usableFundamentalsFeed)).toBeUndefined();
    expect(await feedScope(t.worker.db, member, 'prices')).toMatchObject({
      userId: member,
      shared: false,
    });
    const [audit] = await t.ownerSql`
      select action from audit_event where action like 'admin.feeds_%' order by occurred_at desc limit 1`;
    expect(audit?.action).toBe('admin.feeds_unshared');
    expect(await asApp(admin, (tx) => adminSetFeedSharing(tx, true))).toBe(true);
    expect((await asApp(member, sharedFeeds)).length).toBe(3);
  });
});
