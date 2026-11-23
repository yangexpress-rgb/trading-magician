import {
  getBacktest,
  listBacktestTrades,
  membersAsOf,
  schema,
  storedPeriods,
  syncMembershipPeriods,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import { nyDate, SP500_PERIODS } from '@tm/domain';
import { afterEach, describe, expect, it } from 'vitest';
import { processNextRun } from '../src/backtests';
import { syncSp500Membership } from '../src/groups/membership-sync';
import { resolveBuiltinUniverse } from '../src/universes';
import { createScenario, syntheticFeed } from './earnings-breakout-scenario';

/** Point-in-time S&P 500 membership (data inputs part 2, item C, N324, ADR 0112). */

let t: TestDatabase | undefined;
afterEach(async () => {
  await t?.drop();
  t = undefined;
});

const silent = { info: () => {}, warn: () => {} };

/** Registers stock instruments for symbols, the way a feed's listing would. */
async function register(db: TestDatabase, symbols: readonly string[]) {
  const rows = await db.owner.db
    .insert(schema.instruments)
    .values(
      symbols.map((symbol) => ({
        assetClass: 'stock' as const,
        symbol,
        venue: 'US',
        currency: 'USD',
        displayName: symbol,
        tickSize: '0.01',
      })),
    )
    .returning({ id: schema.instruments.id, symbol: schema.instruments.symbol });
  return new Map(rows.map((r) => [r.symbol, r.id]));
}

describe('S&P 500 membership import (N324)', () => {
  it('stores every period, resolves renames to one instrument, and answers as of a date (C1, C3)', async () => {
    t = await createTestDatabase();
    // The feed lists today's names only: SIVB (failed 2023) and AIV (left 2020, not listed here) don't resolve.
    const listed = await register(t, ['TSLA', 'META', 'AAPL', 'FISV', 'GEN']);
    const asked: string[][] = [];
    const sync = () =>
      syncSp500Membership({
        db: t!.owner.db,
        resolve: async (symbols) => {
          asked.push([...symbols]);
          return new Map([...listed].filter(([s]) => symbols.includes(s)));
        },
        barsFrom: '2016-01-04',
        now: () => new Date('2026-11-23T15:00:00Z'),
        logger: silent,
      });
    const first = await sync();
    expect(first.periods).toBe(SP500_PERIODS.length);
    expect(first.inserted).toBe(SP500_PERIODS.length);
    // Periods that ended before the feed's history have no bars, so no instrument.
    expect(first.beforeBars).toBeGreaterThan(400);
    expect(first.unresolved).toContain('SIVB');
    expect(first.unresolved).not.toContain('FB');
    // Renames are asked for under today's symbol only.
    expect(asked[0]).toContain('META');
    expect(asked[0]).not.toContain('FB');

    const db = t.owner.db;
    const on = async (date: string) => (await membersAsOf(db, 'sp500', date)).map((m) => m.symbol);
    // C1
    expect(await on('2020-06-01')).not.toContain('TSLA');
    expect(await on('2021-06-01')).toContain('TSLA');
    expect(await on('2023-01-03')).toContain('SIVB');
    expect(await on('2023-06-01')).not.toContain('SIVB');
    // C2 against the stored rows
    const count = (await on('2019-06-03')).length;
    expect(count).toBeGreaterThanOrEqual(490);
    expect(count).toBeLessThanOrEqual(510);

    // FB (to 2022-06-09) and META (since) are one instrument; FISV, FI and FISV again too.
    const stored = await storedPeriods(db, 'sp500');
    const idOf = (symbol: string, from?: string) =>
      stored.find((p) => p.symbol === symbol && (!from || p.from === from))?.instrumentId;
    expect(idOf('FB')).toBe(listed.get('META'));
    expect(idOf('META')).toBe(listed.get('META'));
    expect(idOf('FI')).toBe(listed.get('FISV'));
    expect(idOf('SYMC')).toBe(listed.get('GEN'));
    // Unresolved and bar-less rows are kept, with no instrument.
    expect(idOf('SIVB')).toBeNull();
    expect(stored).toHaveLength(SP500_PERIODS.length);

    // C3: a second import of the same file changes nothing.
    const second = await sync();
    expect(second).toMatchObject({ inserted: 0, updated: 0, deleted: 0 });
    expect(second.unchanged).toBe(SP500_PERIODS.length);

    // A symbol a feed lists later resolves on the next run, and only that period changes.
    listed.set('SIVB', (await register(t, ['SIVB'])).get('SIVB')!);
    const third = await sync();
    expect(third.updated).toBe(1);
    expect(third.unresolved).not.toContain('SIVB');

    // Coverage by year (C5): the factor store is empty here, so no resolved period has bars yet.
    const y2023 = third.byYear.find((y) => y.year === 2023)!;
    expect(y2023.members).toBeGreaterThan(500);
    expect(y2023.unresolved + y2023.noBars).toBe(y2023.members);
  }, 60_000);

  it('a file that drops a period deletes it, and a closed period updates', async () => {
    t = await createTestDatabase();
    const db = t.owner.db;
    const ids = await register(t, ['AAA', 'BBB']);
    const base = { groupId: 'sp500', source: 'fja05680-sp500' };
    await syncMembershipPeriods(db, {
      ...base,
      periods: [
        { symbol: 'AAA', from: '2019-01-02', to: null, instrumentId: ids.get('AAA')! },
        { symbol: 'BBB', from: '2019-01-02', to: null, instrumentId: ids.get('BBB')! },
      ],
    });
    const r = await syncMembershipPeriods(db, {
      ...base,
      periods: [
        { symbol: 'AAA', from: '2019-01-02', to: '2020-01-02', instrumentId: ids.get('AAA')! },
      ],
    });
    expect(r).toEqual({ inserted: 0, updated: 1, deleted: 1, unchanged: 0 });
    expect(await membersAsOf(db, 'sp500', '2019-06-03')).toEqual([
      { symbol: 'AAA', instrumentId: ids.get('AAA') },
    ]);
    expect(await membersAsOf(db, 'sp500', '2020-01-02')).toEqual([]);
  }, 60_000);
});

describe('S&P 500 back tests read members as of each day (C4)', () => {
  it('over 2019, trades only members on the days they were members, never unresolved ones', async () => {
    t = await createTestDatabase();
    const scenario = await createScenario(t, {
      members: 5,
      from: '2019-01-02',
      to: '2019-12-31',
      price: '1d',
      earnings: false,
      ranking: true,
      universe: 'sp500',
    });
    const [a, b, c, d, e] = scenario.ids as [string, string, string, string, string];
    // SYN000 all year; SYN001 joins in June; SYN002 leaves in March; SYN003 and SYN004 never
    // members; GONE was a member all year but no feed lists it.
    await syncMembershipPeriods(t.owner.db, {
      groupId: 'sp500',
      source: 'fja05680-sp500',
      periods: [
        { symbol: 'SYN000', from: '2018-01-02', to: null, instrumentId: a },
        { symbol: 'SYN001', from: '2019-06-03', to: null, instrumentId: b },
        { symbol: 'SYN002', from: '2015-01-02', to: '2019-03-01', instrumentId: c },
        { symbol: 'GONE', from: '2015-01-02', to: null, instrumentId: null },
      ],
    });
    const started = await scenario.start();
    if (!('runId' in started)) throw new Error(started.refused);
    const ranges: unknown[] = [];
    const outcome = await processNextRun({
      db: t.app.db,
      provider: syntheticFeed().provider,
      workerId: 'w1',
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      heartbeatMs: 0,
      resolveUniverse: (userId, group, range) => {
        ranges.push(range);
        return resolveBuiltinUniverse({
          db: t!.app.db,
          userId,
          group,
          providers: {},
          privateKey: undefined,
          now: () => new Date('2026-11-23T15:00:00Z'),
          ...(range ? { range } : {}),
        });
      },
    });
    expect(outcome).toBe('completed');
    expect(ranges).toEqual([{ from: '2019-01-02', to: '2019-12-31' }]);
    const run = await scenario.asUser((tx) => getBacktest(tx, started.runId));
    expect(JSON.stringify(run)).toMatch(/point in time/);
    expect(JSON.stringify(run)).toMatch(/GONE/);
    const trades = await scenario.asUser((tx) => listBacktestTrades(tx, started.runId));
    expect(trades.length).toBeGreaterThan(0);
    const spans: Record<string, [string, string | null]> = {
      [a]: ['2018-01-02', null],
      [b]: ['2019-06-03', null],
      [c]: ['2015-01-02', '2019-03-01'],
    };
    const entered = new Set<string>();
    for (const trade of trades) {
      const legs = trade.legs as { instrumentId: string }[];
      const day = nyDate(trade.entryTime!);
      for (const leg of legs) {
        expect([d, e]).not.toContain(leg.instrumentId);
        const span = spans[leg.instrumentId];
        expect(span, leg.instrumentId).toBeDefined();
        expect(day >= span![0] && (span![1] === null || day < span![1])).toBe(true);
        entered.add(leg.instrumentId);
      }
    }
    expect(entered.has(a)).toBe(true);
    expect(entered.has(b)).toBe(true);
  }, 120_000);
});
