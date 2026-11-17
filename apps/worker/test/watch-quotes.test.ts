import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import {
  addWatchGroup,
  addWatchItem,
  createCredential,
  createFeed,
  ensureWatchList,
  generateCredentialKeyPair,
  loadWatchQuotes,
  provisionWorkspace,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaProvider, watchPriceOf } from '../src/alpaca';
import { cboeProvider } from '../src/cboe';
import { fakeCboeFetch } from '../src/cboe-fake';
import type { ProviderRegistry } from '../src/providers';
import { newWatchQuoteState, runWatchQuotes } from '../src/watch-quotes';

/** The watch list (N292): the worker prices open lists through each person's feed. */

let t: TestDatabase;
const keys = generateCredentialKeyPair();
const quiet = { info: () => undefined, warn: () => undefined };
/** Tuesday 2026-10-06, 11:00 New York. */
const NOW = new Date('2026-10-06T15:00:00Z');
const fake = new FakeAlpaca({ now: () => NOW });
const providers: ProviderRegistry = {
  alpaca: alpacaProvider({
    fetch: fake.fetch,
    fake: { tradingUrl: FAKE_ALPACA_TRADING_URL, dataUrl: FAKE_ALPACA_DATA_URL },
    sleep: async () => {},
  }),
  cboe: cboeProvider({ fetch: fakeCboeFetch(() => NOW) }),
};
const opts = () => ({
  db: t.worker.db,
  providers,
  privateKey: keys.privateKey,
  logger: quiet,
  now: () => NOW,
});
const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string) {
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Watch', email })
    .returning({ id: schema.users.id });
  await provisionWorkspace(t.app.db, { userId: row!.id, displayName: 'Watch' });
  return row!.id;
}

beforeAll(async () => {
  t = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('watch list prices', () => {
  it('prices an open list through the person’s Alpaca feed, and the VIX from Cboe', async () => {
    const user = await createUser('watch-worker@example.test');
    await as(user, async (tx) => {
      const credential = await createCredential(tx, {
        userId: user,
        provider: 'alpaca',
        label: 'Alpaca paper',
        fields: { keyId: fake.credentials.keyId, secretKey: fake.credentials.secretKey },
        publicKey: keys.publicKey,
      });
      await createFeed(tx, {
        userId: user,
        name: 'Alpaca prices',
        provider: 'alpaca',
        credentialId: credential.id,
        assetClasses: ['stock', 'etf'],
      });
      await ensureWatchList(tx, user);
      const group = await addWatchGroup(tx, user, 'Fake');
      await addWatchItem(tx, user, { groupId: group, symbol: 'ZTSTA' });
    });

    const state = newWatchQuoteState();
    const written = await runWatchQuotes(opts(), state);
    expect(written).toBeGreaterThanOrEqual(2);
    const quotes = await as(user, (tx) => loadWatchQuotes(tx, ['ZTSTA', 'VIX', 'AAPL']));
    const a = quotes.find((q) => q.symbol === 'ZTSTA')!;
    expect(a.last).toBeGreaterThan(0);
    expect(a.prevClose).toBeGreaterThan(0);
    expect(a).toMatchObject({ daily: false, source: 'alpaca-iex' });
    const vix = quotes.find((q) => q.symbol === 'VIX')!;
    expect(vix).toMatchObject({ daily: true });
    expect(vix.prevClose).toBeGreaterThan(0);
    // The fake has no AAPL: no price, nothing made up.
    expect(quotes.some((q) => q.symbol === 'AAPL')).toBe(false);

    // Asked again only once the refresh interval has passed.
    expect(await runWatchQuotes(opts(), state)).toBe(0);
  });

  it('prices nothing while no list is open', async () => {
    await t.ownerSql`update watch_list_view set viewed_at = now() - interval '10 minutes'`;
    expect(await runWatchQuotes(opts(), newWatchQuoteState())).toBe(0);
  });
});

describe('watchPriceOf', () => {
  const bar = (t: string, c: number) => ({ t, o: c, h: c, l: c, c, v: 1, n: 1, vw: c });
  const trade = (p: number) => ({
    t: '2026-10-06T15:00:00Z',
    x: 'V',
    p,
    s: 1,
    c: [],
    i: 1,
    z: 'C',
  });

  it('measures from the day before today’s bar', () => {
    const p = watchPriceOf(
      {
        latestTrade: trade(101),
        latestQuote: null,
        minuteBar: null,
        dailyBar: bar('2026-10-06T04:00:00Z', 101),
        prevDailyBar: bar('2026-10-05T04:00:00Z', 100),
      },
      NOW,
    );
    expect(p).toMatchObject({ last: 101, prevClose: 100 });
  });

  it('before today has a bar, measures from the latest one', () => {
    const p = watchPriceOf(
      {
        latestTrade: trade(99),
        latestQuote: null,
        minuteBar: null,
        dailyBar: bar('2026-10-05T04:00:00Z', 100),
        prevDailyBar: bar('2026-10-02T04:00:00Z', 98),
      },
      new Date('2026-10-06T12:00:00Z'),
    );
    expect(p).toMatchObject({ last: 99, prevClose: 100 });
  });

  it('on a weekend, keeps Friday’s change', () => {
    const p = watchPriceOf(
      {
        latestTrade: trade(101),
        latestQuote: null,
        minuteBar: null,
        dailyBar: bar('2026-10-09T04:00:00Z', 101),
        prevDailyBar: bar('2026-10-08T04:00:00Z', 100),
      },
      new Date('2026-10-10T15:00:00Z'),
    );
    expect(p).toMatchObject({ last: 101, prevClose: 100 });
  });

  // N296: regular session apart from pre-market and after-hours trades.
  const at = (t: string, p: number) => ({ ...trade(p), t });
  const tuesday = bar('2026-11-17T05:00:00Z', 200);
  const monday = bar('2026-11-16T05:00:00Z', 196);

  it('during the session, the latest trade is the regular price', () => {
    const p = watchPriceOf(
      {
        latestTrade: at('2026-11-17T18:00:00Z', 201),
        latestQuote: null,
        minuteBar: null,
        dailyBar: tuesday,
        prevDailyBar: monday,
      },
      new Date('2026-11-17T18:00:05Z'),
    );
    expect(p).toMatchObject({ last: 201, prevClose: 196, extLast: null });
  });

  it('after the close, keeps the close and the after-hours trade apart', () => {
    const p = watchPriceOf(
      {
        latestTrade: at('2026-11-17T22:00:00Z', 202),
        latestQuote: null,
        minuteBar: null,
        dailyBar: tuesday,
        prevDailyBar: monday,
      },
      new Date('2026-11-17T22:00:05Z'),
    );
    expect(p).toMatchObject({ last: 200, prevClose: 196, extLast: 202 });
    expect(p?.priceAt.toISOString()).toBe('2026-11-17T21:00:00.000Z');
    expect(p?.extAt?.toISOString()).toBe('2026-11-17T22:00:00.000Z');
  });

  it('before the next open, the last session stays the regular price', () => {
    const p = watchPriceOf(
      {
        latestTrade: at('2026-11-18T13:00:00Z', 199),
        latestQuote: null,
        minuteBar: null,
        dailyBar: tuesday,
        prevDailyBar: monday,
      },
      new Date('2026-11-18T13:00:05Z'),
    );
    expect(p).toMatchObject({ last: 200, prevClose: 196, extLast: 199 });
  });
});
