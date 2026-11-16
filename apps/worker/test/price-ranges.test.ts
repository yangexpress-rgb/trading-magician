import { loadPriceRange, loadPriceRanges, priceRangeMembers, registerInstrument } from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { regularSession, tradingDays, type Bar, type HistoricalDataProvider } from '@tm/domain';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runPriceRangePass, settledDay, type Tried } from '../src/price-ranges';

/**
 * The 52-week low and high job (N290): stores each member's figures as of
 * the last settled session, replaces them a session later, and leaves out a
 * stock with under a year of prices.
 */

let t: TestDatabase;
const ids: Record<string, string> = {};
const quiet = { info: () => undefined, warn: () => undefined };

/** RNGA falls to 50 on 2025-06-02, then recovers; RNGB is listed only from 2025-09-02. */
function provider(calls: { requests: number }): HistoricalDataProvider {
  return {
    id: 'range-test',
    intervals: ['1d'],
    async getBars(req) {
      calls.requests++;
      const bars: Bar[] = [];
      const start = req.symbol === 'RNGB' ? '2025-09-02' : '2024-01-02';
      for (const d of tradingDays(start, req.to)) {
        const session = regularSession(d);
        if (!session || d < req.from) continue;
        const price = d === '2025-06-02' ? 50 : 100 + (d > '2025-06-02' ? 5 : 0);
        const high = d === '2025-10-01' ? 140 : price + 1;
        bars.push({
          start: session.open,
          end: session.close,
          open: new Decimal(price),
          high: new Decimal(high),
          low: new Decimal(price - 1),
          close: new Decimal(price),
          volume: new Decimal(1000),
        });
      }
      return { bars, dataVersion: 'range-test@1', warnings: [] };
    },
  };
}

beforeAll(async () => {
  t = await createTestDatabase();
  for (const symbol of ['RNGA', 'RNGB'])
    ids[symbol] = await t.worker.db.transaction((tx) =>
      registerInstrument(tx, {
        assetClass: 'stock',
        symbol,
        venue: 'NYSE',
        displayName: symbol,
        provider: 'alpaca',
        providerId: `${symbol}-test`,
      }),
    );
});

afterAll(async () => {
  await t?.drop();
});

describe('52-week ranges job', () => {
  it('counts registered US stocks as members', async () => {
    const members = await priceRangeMembers(t.worker.db);
    expect(members).toEqual(expect.arrayContaining([ids.RNGA, ids.RNGB]));
  });

  it('stores the figures as of the last settled session, then waits for the next', async () => {
    const calls = { requests: 0 };
    const tried = new Map<string, Tried>();
    // Friday 2025-11-14, 21:40 UTC: 40 minutes after the close, so that session counts.
    const now = new Date('2025-11-14T21:40:00Z');
    expect(settledDay(now)).toBe('2025-11-14');
    const run = (at: Date) =>
      runPriceRangePass({
        db: t.worker.db,
        history: provider(calls),
        members: async () => [ids.RNGA as string, ids.RNGB as string],
        now: () => at,
        logger: quiet,
        tried,
      });
    const first = await run(now);
    expect(first.written).toBe(1);
    expect(first.pending).toBe(0);
    const a = await t.app.db.transaction((tx) => loadPriceRange(tx, ids.RNGA as string));
    expect(a?.asOf).toBe('2025-11-14');
    expect(a?.low).toEqual({
      price: 49,
      on: '2025-06-02',
      days: tradingDays('2025-06-02', '2025-11-14').length - 1,
    });
    expect(a?.high).toEqual({
      price: 140,
      on: '2025-10-01',
      days: tradingDays('2025-10-01', '2025-11-14').length - 1,
    });
    // Under a year of prices: nothing stored.
    expect(await t.app.db.transaction((tx) => loadPriceRange(tx, ids.RNGB as string))).toBeNull();

    // Nothing new until the next session settles; RNGB, short of a year, is not asked again that day.
    const before = calls.requests;
    expect((await run(new Date('2025-11-14T22:10:00Z'))).written).toBe(0);
    expect(calls.requests).toBe(before);

    const next = await run(new Date('2025-11-17T21:40:00Z'));
    expect(next.written).toBe(1);
    const all = await t.app.db.transaction((tx) => loadPriceRanges(tx));
    expect(all.bySymbol.get('RNGA')?.asOf).toBe('2025-11-17');
    expect(all.bySymbol.get('RNGA')?.low.days).toBe(a!.low.days + 1);
  });
});
