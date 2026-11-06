import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import {
  createCredential,
  createFeed,
  generateCredentialKeyPair,
  getStockScreen,
  getStockScreenData,
  provisionWorkspace,
  requestStockScreen,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { fromScreenTuple } from '@tm/domain';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaProvider } from '../src/alpaca';
import { demoProvider, type ProviderRegistry } from '../src/providers';
import { runStockScreens } from '../src/stock-screens';

/**
 * The stock screener (ADR 0030): the web app queues a screen, the worker
 * fills it in from the tenant's US stock feed, or the demo feed in tests.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
const keys = generateCredentialKeyPair();
const quiet = { info: () => undefined, warn: () => undefined };
/** Tuesday 2026-10-06, 11:00 New York. */
const NOW = new Date('2026-10-06T15:00:00Z');
const fake = new FakeAlpaca({ now: () => NOW });
const providers: ProviderRegistry = {
  demo: demoProvider(
    (now) => createDemoLiveFeed({ now }),
    (now) => createDemoHistoryProvider({ now }),
  ),
  alpaca: alpacaProvider({
    fetch: fake.fetch,
    fake: { tradingUrl: FAKE_ALPACA_TRADING_URL, dataUrl: FAKE_ALPACA_DATA_URL },
    sleep: async () => {},
  }),
};
const opts = { providers, privateKey: keys.privateKey, logger: quiet, now: () => NOW };
const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string) {
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Screens', email })
    .returning({ id: schema.users.id });
  await provisionWorkspace(t.app.db, { userId: row!.id, displayName: 'Screens' });
  return row!.id;
}

async function screen(userId: string, fresh = false) {
  const started = await as(userId, (tx) => requestStockScreen(tx, { userId, fresh }));
  await runStockScreens({ db: t.worker.db, ...opts });
  return as(userId, (tx) => getStockScreenData(tx, started.id));
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('screens-a@example.test');
  userB = await createUser('screens-b@example.test');
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('stock screens', () => {
  it('screens the demo instruments without a real feed', async () => {
    const done = await screen(userA);
    expect(done.status).toBe('ready');
    expect(done.sessionDate).toBe('2026-10-06');
    const rows = done.rows!.map(fromScreenTuple);
    expect(rows.map((r) => r.symbol)).toContain('DEMO-IDX');
    const idx = rows.find((r) => r.symbol === 'DEMO-IDX')!;
    // Demo instruments are registered, so they can be charted at once.
    expect(idx.instrumentId).toMatch(/^[0-9a-f-]{36}$/);
    expect(idx.open).toBeGreaterThan(0);
    expect(idx.prevClose).toBeGreaterThan(0);
    expect(idx.changePct).not.toBeNull();
    expect(idx.change1mPct).not.toBeNull();
    expect(done.rowCount).toBe(rows.length);
  });

  it('says to add a feed when there is none (demo data off, ADR 0039)', async () => {
    const [row] = await t.auth.db
      .insert(schema.users)
      .values({ name: 'No feed', email: 'screens-nofeed@example.test' })
      .returning({ id: schema.users.id });
    const nofeed = row!.id;
    await provisionWorkspace(t.app.db, { userId: nofeed, displayName: 'No feed', demo: false });
    const done = await screen(nofeed);
    expect(done.status).toBe('failed');
    expect(done.message).toMatch(/Add an Alpaca data feed/);
  });

  it('hands back a recent screen, and a fresh one when asked', async () => {
    const first = await as(userA, (tx) => requestStockScreen(tx, { userId: userA }));
    expect(first.status).toBe('ready');
    const again = await as(userA, (tx) => requestStockScreen(tx, { userId: userA, fresh: true }));
    expect(again.id).not.toBe(first.id);
    expect(again.status).toBe('pending');
    await runStockScreens({ db: t.worker.db, ...opts });
  });

  it('keeps each person’s screens to themselves', async () => {
    const mine = await as(userA, (tx) => requestStockScreen(tx, { userId: userA }));
    await expect(as(userB, (tx) => getStockScreen(tx, mine.id))).rejects.toThrow(/No such screen/);
  });

  it('screens every listed US stock through an Alpaca feed', async () => {
    await as(userB, async (tx) => {
      const credential = await createCredential(tx, {
        userId: userB,
        provider: 'alpaca',
        label: 'Alpaca paper',
        fields: { keyId: fake.credentials.keyId, secretKey: fake.credentials.secretKey },
        publicKey: keys.publicKey,
      });
      await createFeed(tx, {
        userId: userB,
        name: 'Alpaca prices',
        provider: 'alpaca',
        credentialId: credential.id,
        assetClasses: ['stock', 'etf'],
      });
    });
    const done = await screen(userB);
    expect(done.status).toBe('ready');
    expect(done.source).toBe('Alpaca prices');
    expect(done.warnings.join(' ')).toMatch(/IEX/);
    const rows = done.rows!.map(fromScreenTuple);
    expect(rows.map((r) => r.symbol).sort()).toEqual(['ZTSTA', 'ZTSTB', 'ZTSTX']);
    const a = rows.find((r) => r.symbol === 'ZTSTA')!;
    expect(a.last).toBeGreaterThan(0);
    expect(a.prevClose).toBeGreaterThan(0);
    expect(a.prevChangePct).not.toBeNull();
    expect(a.change5dPct).not.toBeNull();
    expect(a.instrumentId).toBeNull();
  });

  it('screens only the S&P 500 members when asked', async () => {
    const started = await as(userB, (tx) =>
      requestStockScreen(tx, { userId: userB, universe: 'sp500', fresh: true }),
    );
    expect(started.universe).toBe('sp500');
    await runStockScreens({ db: t.worker.db, ...opts });
    const done = await as(userB, (tx) => getStockScreenData(tx, started.id));
    expect(done.status).toBe('ready');
    // The fake's made-up symbols are not in the index.
    expect(done.rows).toEqual([]);
    // A screen of the whole market is a different request.
    const all = await as(userB, (tx) => requestStockScreen(tx, { userId: userB }));
    expect(all.universe).toBe('all');
    expect(all.id).not.toBe(started.id);
  });

  it('reports a refused key', async () => {
    fake.failNext(401, 1);
    const done = await screen(userB, true);
    expect(done.status).toBe('failed');
    expect(done.message).toMatch(/refused its API key/);
  });
});
