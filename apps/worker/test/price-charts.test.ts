import { FAKE_ALPACA_DATA_URL, FAKE_ALPACA_TRADING_URL, FakeAlpaca } from '@tm/alpaca/testing';
import {
  createCredential,
  createFeed,
  eq,
  generateCredentialKeyPair,
  getInstrumentLookup,
  getPriceChart,
  provisionWorkspace,
  requestInstrumentLookup,
  requestPriceChart,
  schema,
  withTenant,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { createDemoHistoryProvider, createDemoLiveFeed } from '@tm/market-data';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { alpacaProvider } from '../src/alpaca';
import { runInstrumentLookups } from '../src/instrument-lookups';
import { runPriceCharts } from '../src/price-charts';
import { demoProvider, type ProviderRegistry } from '../src/providers';

/**
 * Price charts for Quantitative Research (ADR 0029): the web app queues a
 * chart, the worker answers it through the tenant's bars route.
 */

let t: TestDatabase;
let userA: string;
let userB: string;
let demoIdx: string;
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
  }),
};
const opts = { providers, privateKey: keys.privateKey, logger: quiet, now: () => NOW };
const charts = () => runPriceCharts({ db: t.worker.db, ...opts });
const as = <T>(userId: string, fn: (tx: Transaction) => Promise<T>) =>
  withTenant(t.app.db, { userId }, fn);

async function createUser(email: string) {
  const [row] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'Charts', email })
    .returning({ id: schema.users.id });
  await provisionWorkspace(t.app.db, { userId: row!.id, displayName: 'Charts' });
  return row!.id;
}

async function chart(
  userId: string,
  instrumentId: string,
  range: '1d' | '1w' | '1m' | '3m' | '6m' | '1y' | '5y' = '1m',
  interval: '5m' | '1d' | '1h' = '1d',
  end?: string,
) {
  const started = await as(userId, (tx) =>
    requestPriceChart(tx, { userId, instrumentId, range, interval, end, now: NOW }),
  );
  await charts();
  return as(userId, (tx) => getPriceChart(tx, started.id));
}

beforeAll(async () => {
  t = await createTestDatabase();
  userA = await createUser('charts-a@example.test');
  userB = await createUser('charts-b@example.test');
  const [row] = await t.owner.db
    .select()
    .from(schema.instruments)
    .where(eq(schema.instruments.symbol, 'DEMO-IDX'));
  demoIdx = row!.id;
}, 60_000);

afterAll(async () => {
  await t?.drop();
});

describe('price charts', () => {
  it('charts a demo instrument from the demo feed', async () => {
    const c = await chart(userA, demoIdx, '1m');
    expect(c).toMatchObject({
      status: 'ready',
      interval: '1d',
      range: '1m',
      from: '2026-09-05',
      to: '2026-10-06',
      instrument: { symbol: 'DEMO-IDX' },
      message: null,
    });
    expect(c.source).toBeTruthy();
    // About a month of trading days, oldest first, each [t, o, h, l, c, v].
    expect(c.bars!.length).toBeGreaterThan(18);
    expect(c.bars!.length).toBeLessThan(24);
    const [first] = c.bars!;
    expect(first).toHaveLength(6);
    expect(first![2]).toBeGreaterThanOrEqual(Math.max(first![1], first![4]));
    expect(first![3]).toBeLessThanOrEqual(Math.min(first![1], first![4]));
    const times = c.bars!.map((b) => b[0]);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    // Only finished bars: today's daily bar is still open at 11:00.
    expect(times.at(-1)).toBeLessThan(Date.parse('2026-10-06T13:30:00Z'));
  });

  it('gives hourly bars for short ranges and refuses them for long ones', async () => {
    const hourly = await chart(userA, demoIdx, '1w', '1h');
    expect(hourly.status).toBe('ready');
    expect(hourly.bars!.length).toBeGreaterThan(20);
    await expect(
      as(userA, (tx) =>
        requestPriceChart(tx, {
          userId: userA,
          instrumentId: demoIdx,
          range: '1y',
          interval: '1h',
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/hourly bars up to 3 months/);
  });

  it('shows one day as 5-minute bars of the latest session', async () => {
    // 11:00 on Tuesday 6 October: today's session so far, 9:30 to 11:00.
    const today = await chart(userA, demoIdx, '1d', '5m');
    expect(today.status).toBe('ready');
    expect(today.bars).toHaveLength(18);
    expect(today.bars![0]![0]).toBe(Date.parse('2026-10-06T13:30:00Z'));
    expect(today.bars!.at(-1)![0]).toBe(Date.parse('2026-10-06T14:55:00Z'));
    await expect(
      as(userA, (tx) =>
        requestPriceChart(tx, {
          userId: userA,
          instrumentId: demoIdx,
          range: '1m',
          interval: '5m',
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/5-minute bars go back up to a week/);
  });

  it('ends on an earlier date the person went to (N196)', async () => {
    const week = await chart(userA, demoIdx, '1w', '5m', '2026-09-18');
    expect(week).toMatchObject({ status: 'ready', from: '2026-09-11', to: '2026-09-18' });
    const times = week.bars!.map((b) => b[0]);
    expect(times[0]).toBeGreaterThanOrEqual(Date.parse('2026-09-11T13:30:00Z'));
    expect(times.at(-1)).toBeLessThan(Date.parse('2026-09-18T20:00:00Z'));
    // A day ending on a Sunday is the Friday session before it.
    const sunday = await chart(userA, demoIdx, '1d', '5m', '2026-09-20');
    expect(sunday.bars).toHaveLength(78);
    expect(sunday.bars![0]![0]).toBe(Date.parse('2026-09-18T13:30:00Z'));
    // Another end date is another chart, not the recent one for today.
    const today = await chart(userA, demoIdx, '1w', '5m');
    expect(today.id).not.toBe(week.id);
    expect(today.to).toBe('2026-10-06');
  });

  it('reuses a recent chart instead of asking the feed again', async () => {
    const first = await chart(userA, demoIdx, '6m');
    const again = await as(userA, (tx) =>
      requestPriceChart(tx, {
        userId: userA,
        instrumentId: demoIdx,
        range: '6m',
        interval: '1d',
        now: NOW,
      }),
    );
    expect(again.id).toBe(first.id);
    expect(again.status).toBe('ready');
  });

  it('keeps charts private to their tenant', async () => {
    const mine = await chart(userA, demoIdx, '3m');
    await expect(as(userB, (tx) => getPriceChart(tx, mine.id))).rejects.toThrow(/No such chart/);
  });

  it('charts only instruments the tenant can pick', async () => {
    // userA looks up a real stock; userB may not chart it.
    await as(userA, async (tx) => {
      const credential = await createCredential(tx, {
        userId: userA,
        provider: 'alpaca',
        label: 'Alpaca paper',
        fields: { keyId: fake.credentials.keyId, secretKey: fake.credentials.secretKey },
        publicKey: keys.publicKey,
      });
      await createFeed(tx, {
        userId: userA,
        name: 'Alpaca prices',
        provider: 'alpaca',
        credentialId: credential.id,
        assetClasses: ['stock', 'etf'],
      });
    });
    const started = await as(userA, (tx) =>
      requestInstrumentLookup(tx, { userId: userA, symbol: 'ZTSTA' }),
    );
    await runInstrumentLookups({ db: t.worker.db, ...opts });
    const found = await as(userA, (tx) => getInstrumentLookup(tx, started.id));
    const real = found.instrument!.id;

    const c = await chart(userA, real, '1m');
    expect(c).toMatchObject({ status: 'ready', source: 'Alpaca prices' });
    expect(c.bars!.length).toBeGreaterThan(10);
    expect(c.warnings.join(' ')).toMatch(/IEX/);
    const day = await chart(userA, real, '1d', '5m');
    expect(day).toMatchObject({ status: 'ready', source: 'Alpaca prices' });
    expect(day.bars).toHaveLength(18);

    await expect(
      as(userB, (tx) =>
        requestPriceChart(tx, {
          userId: userB,
          instrumentId: real,
          range: '1m',
          interval: '1d',
          now: NOW,
        }),
      ),
    ).rejects.toThrow(/No such instrument/);
  });

  it('clears charts older than a day', async () => {
    const old = await chart(userB, demoIdx, '1y');
    await t.owner.db
      .update(schema.priceCharts)
      .set({ createdAt: new Date(Date.now() - 2 * 86_400_000) })
      .where(eq(schema.priceCharts.id, old.id));
    await charts();
    const rows = await t.owner.db
      .select()
      .from(schema.priceCharts)
      .where(eq(schema.priceCharts.id, old.id));
    expect(rows).toHaveLength(0);
  });
});
