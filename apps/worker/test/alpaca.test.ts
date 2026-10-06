import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import {
  createCredential,
  createFeed,
  eq,
  generateCredentialKeyPair,
  getInstrumentLookup,
  listTenantInstruments,
  loadRouting,
  provisionWorkspace,
  registerInstrument,
  requestInstrumentLookup,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaProvider } from '../src/alpaca';
import { runInstrumentLookups } from '../src/instrument-lookups';
import { demoProvider, type ProviderRegistry } from '../src/providers';
import { createRoutedHistory } from '../src/routed-history';
import { createRoutedQuotes } from '../src/routed-quotes';

/**
 * Alpaca through the worker (ADR 0017), against the fake: symbol lookups
 * register real instruments, and their prices and bars follow the routes.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
const keys = generateCredentialKeyPair();
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
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
  }),
};
const lookups = () =>
  runInstrumentLookups({
    db: t.worker.db,
    providers,
    privateKey: keys.privateKey,
    logger: quiet,
    now: () => NOW,
  });
const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);
const asWorker = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.worker.db, { userId }, fn);

async function createUser(email: string) {
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Alpaca', email })
    .returning({ id: schema.users.id });
  await provisionWorkspace(t.app.db, { userId: row!.id, displayName: 'Alpaca' });
  return row!.id;
}

async function connectAlpaca(userId: string, secretKey = fake.credentials.secretKey) {
  return as(userId, async (tx) => {
    const credential = await createCredential(tx, {
      userId,
      provider: 'alpaca',
      label: 'Alpaca paper',
      fields: { keyId: fake.credentials.keyId, secretKey },
      publicKey: keys.publicKey,
    });
    const feed = await createFeed(tx, {
      userId,
      name: 'Alpaca prices',
      provider: 'alpaca',
      credentialId: credential.id,
      assetClasses: ['stock', 'etf'],
    });
    // Adding the feed routes US stocks and ETFs to it.
    return feed;
  });
}

async function lookUp(userId: string, symbol: string) {
  const started = await as(userId, (tx) => requestInstrumentLookup(tx, { userId, symbol }));
  await lookups();
  return as(userId, (tx) => getInstrumentLookup(tx, started.id));
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('alpaca-a@example.test');
  userB = await createUser('alpaca-b@example.test');
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('instrument lookups', () => {
  it('asks for a US data feed first', async () => {
    const result = await lookUp(userB, 'ztsta');
    expect(result).toMatchObject({ symbol: 'ZTSTA', status: 'failed', instrument: null });
    expect(result.message).toMatch(/Add a data feed for US stocks/);
  });

  it('finds a US stock through the Alpaca feed and keeps it private to the tenant', async () => {
    await connectAlpaca(userA);
    const found = await lookUp(userA, 'ZTSTA');
    expect(found).toMatchObject({
      status: 'found',
      instrument: { symbol: 'ZTSTA', assetClass: 'stock', venue: 'NASDAQ' },
    });
    const [row] = await t.owner.db
      .select()
      .from(schema.instruments)
      .where(eq(schema.instruments.id, found.instrument!.id));
    expect(row).toMatchObject({
      isDemo: false,
      currency: 'USD',
      providerIds: { alpaca: expect.any(String) },
    });

    expect((await as(userA, (tx) => listTenantInstruments(tx))).map((i) => i.symbol)).toContain(
      'ZTSTA',
    );
    expect((await as(userB, (tx) => listTenantInstruments(tx))).map((i) => i.symbol)).not.toContain(
      'ZTSTA',
    );

    // Looking it up again reuses the same instrument.
    const again = await lookUp(userA, 'ZTSTA');
    expect(again.instrument?.id).toBe(found.instrument!.id);
    expect((await lookUp(userA, 'ZTSTX')).instrument).toMatchObject({ assetClass: 'etf' });
  });

  it('says when nothing trades under a symbol, and refuses nonsense', async () => {
    const missing = await lookUp(userA, 'NOSUCH');
    expect(missing).toMatchObject({ status: 'not_found' });
    expect(missing.message).toBe('No US stock or ETF trades as NOSUCH.');
    await expect(
      as(userA, (tx) => requestInstrumentLookup(tx, { userId: userA, symbol: '../etc' })),
    ).rejects.toMatchObject({ code: 'bad_request' });
  });

  it('reports a refused key without showing it', async () => {
    const user = await createUser('alpaca-c@example.test');
    await connectAlpaca(user, 'a-wrong-secret-value-0000000000');
    const failed = await lookUp(user, 'ZTSTB');
    expect(failed.status).toBe('failed');
    expect(failed.message).toMatch(/refused its API key/);
    expect(JSON.stringify(failed)).not.toContain('a-wrong-secret');
  });

  it('lets only the worker register instruments, never on the demo venue', async () => {
    const instrument = {
      assetClass: 'stock' as const,
      symbol: 'ZZZZ',
      venue: 'NASDAQ',
      displayName: 'Nope',
      provider: 'alpaca',
      providerId: 'x',
    };
    await expect(as(userA, (tx) => registerInstrument(tx, instrument))).rejects.toThrow();
    await expect(
      asWorker(userA, (tx) => registerInstrument(tx, { ...instrument, venue: 'DEMO' })),
    ).rejects.toThrow();
  });
});

describe('routing a real instrument', () => {
  it('prices and bars a looked-up instrument through the Alpaca feed', async () => {
    const found = await lookUp(userA, 'ZTSTB');
    const instrument = found.instrument!;
    const quote = await asWorker(userA, async (tx) =>
      createRoutedQuotes({
        tx,
        userId: userA,
        now: NOW,
        routing: await loadRouting(tx),
        providers,
        privateKey: keys.privateKey,
        logger: quiet,
      }).latestQuote({ instrumentId: instrument.id, symbol: instrument.symbol }),
    );
    expect(quote).toMatchObject({ source: 'alpaca-iex', marketOpen: true, symbol: 'ZTSTB' });

    const history = createRoutedHistory({
      inTenant: (fn) => withTenant(t.worker.db, { userId: userA }, fn),
      userId: userA,
      now: () => NOW,
      providers,
      privateKey: keys.privateKey,
    });
    const { bars, dataVersion, warnings } = await history.getBars({
      instrumentId: instrument.id,
      symbol: instrument.symbol,
      assetClass: 'stock',
      interval: '1d',
      from: '2026-09-01',
      to: '2026-09-30',
      adjustment: 'split_and_dividend',
      session: 'regular',
    });
    expect(bars).toHaveLength(21);
    expect(dataVersion).toMatch(/^alpaca-iex-/);
    expect(warnings.join(' ')).toMatch(/IEX/);
  });

  it('still bars demo instruments from the demo feed', async () => {
    const [demoA] = await t.owner.db
      .select()
      .from(schema.instruments)
      .where(eq(schema.instruments.symbol, 'DEMO-A'));
    const history = createRoutedHistory({
      inTenant: (fn) => withTenant(t.worker.db, { userId: userA }, fn),
      userId: userA,
      now: () => NOW,
      providers,
      privateKey: keys.privateKey,
    });
    const { dataVersion } = await history.getBars({
      instrumentId: demoA!.id,
      symbol: 'DEMO-A',
      assetClass: 'stock',
      interval: '1d',
      from: '2026-09-01',
      to: '2026-09-30',
      adjustment: 'none',
      session: 'regular',
    });
    expect(dataVersion).not.toMatch(/alpaca/);
  });
});
