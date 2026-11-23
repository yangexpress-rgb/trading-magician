import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_BACKTEST_INPUTS } from '@tm/backtest';
import {
  createStrategy,
  eq,
  factorCoverageReport,
  getBacktest,
  loadEventData,
  provisionWorkspace,
  rateCoverage,
  registerInstrument,
  saveFactorSnapshots,
  saveRates,
  schema,
  startBacktest,
  withTenant,
  isBondMarketHoliday,
  loadValidationContext,
  type Transaction,
} from '@tm/db';
import { createTestDatabase, type TestDatabase } from '@tm/db/testing';
import {
  createDefinition,
  EVENT_HISTORY_FROM,
  eventPointAt,
  getMetric,
  regularSession,
  tradingDays,
  validateStrategy,
  type Bar,
  type Expr,
  type HistoricalDataProvider,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processNextRun } from '../src/backtests';
import { runEventsPass } from '../src/events/loop';
import { rateSeriesRefresher } from '../src/events/rate-series';
import { marketInputs } from '../src/options/market-inputs';
import { fillMarketLevel } from '../src/patterns/loop';

/**
 * Data inputs part 2, item A (N322): the five market-regime FRED series, on
 * slices of FRED's own CSVs captured 2026-11-23 (test/fixtures/fred). A1:
 * T-bill readings are identical to the ones the build before N322 gave; A2:
 * known answers; A3: the coverage report; A4: a strategy on the high-yield
 * spread validates and back tests (inside FRED's three-year window, as Yong
 * chose 2026-11-23); and the market-level fill of older snapshot rows.
 */

const FIXTURES = join(__dirname, 'fixtures', 'fred');
const csv = (id: string) => readFileSync(join(FIXTURES, `${id}.csv`), 'utf8');
const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

/** Serves the fixture CSVs as FRED's fredgraph.csv?id=… route. */
const served: string[] = [];
const fredFetch = async (url: string) => {
  const id = new URL(url).searchParams.get('id') ?? '';
  served.push(id);
  try {
    return new Response(csv(id), { status: 200, headers: { 'content-type': 'text/csv' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
};
const FRED_URL = 'http://fred.test/graph/fredgraph.csv';

let t: TestDatabase;
let spy: string;
let userId: string;
let account: string;

beforeAll(async () => {
  t = await createTestDatabase();
  // DTB3 as the build stores it: through the options market inputs (ADR 0058).
  const inputs = marketInputs({
    history: undefined,
    fredUrl: FRED_URL,
    fetch: fredFetch,
    onRates: (days) => saveRates(t.worker.db, days, EVENT_HISTORY_FROM).then(() => undefined),
  });
  await inputs.riskFreeRate('2026-11-20');
  await rateSeriesRefresher({
    db: t.worker.db,
    fredUrl: FRED_URL,
    fetch: fredFetch,
    logger: quiet,
  }).refresh();
  spy = await t.worker.db.transaction((tx) =>
    registerInstrument(tx, {
      assetClass: 'etf',
      symbol: 'SPY',
      venue: 'ARCA',
      displayName: 'SPY',
      provider: 'alpaca',
      providerId: 'SPY-rates-test',
    }),
  );
  const [user] = await t.auth.db
    .insert(schema.users)
    .values({ name: 'r', email: 'rates@example.test' })
    .returning({ id: schema.users.id });
  userId = user!.id;
  await provisionWorkspace(t.app.db, { userId, displayName: 'R' });
  account = (
    await withTenant(t.app.db, { userId }, (tx) => tx.select().from(schema.tradingAccounts))
  )[0]!.id;
  await t.ownerSql`update trading_account
    set capabilities = jsonb_set(capabilities, '{coverage}', '"us"') where id = ${account}`;
}, 120_000);

afterAll(async () => {
  await t?.drop();
});

const closeOf = (d: string) => Date.parse(regularSession(d)?.close ?? `${d}T21:00:00Z`);
const reads = (metrics: string[]) => new Map([[spy, new Set(metrics)]]);

describe('A1: T-bill readings are unchanged', () => {
  it('reads every sample date exactly as the build before N322 did', async () => {
    const before = JSON.parse(
      readFileSync(join(FIXTURES, 'tbill-readings-before.json'), 'utf8'),
    ) as {
      readings: { date: string; value: string | null; asOfDate: string | null }[];
    };
    // Load everything at once, as a strategy reading the T-bill and a regime series would.
    const data = await loadEventData(t.app.db, reads(['rates.tbill_3m', 'rates.ust_10y']));
    expect(before.readings.length).toBeGreaterThan(5);
    for (const r of before.readings) {
      const p = eventPointAt(data, spy, 'rates.tbill_3m', closeOf(r.date), undefined);
      expect({
        date: r.date,
        value: p ? p.value.toString() : null,
        asOfDate: p?.asOfDate ?? null,
      }).toEqual(r);
    }
  });

  it('keeps DTB3 from February 2024 while the regime series reach back to 2016', async () => {
    const data = await loadEventData(t.app.db, reads(['rates.tbill_3m', 'rates.ust_10y']));
    expect(data.rates[0]?.date).toBe('2024-02-01');
    expect(data.rateSeries?.get('rates.ust_10y')?.[0]).toEqual({
      date: '2016-01-04',
      value: 0.0224,
    });
  });
});

describe('A2: known answers', () => {
  it('reads the 10-year at 4.98% on 2023-10-19', async () => {
    const data = await loadEventData(t.app.db, reads(['rates.ust_10y']));
    const p = eventPointAt(data, spy, 'rates.ust_10y', closeOf('2023-10-19'), undefined);
    expect(p?.asOfDate).toBe('2023-10-19');
    expect(Math.abs(p!.value.toNumber() - 0.0498)).toBeLessThanOrEqual(0.0005);
  });

  it('reads the 10y−2y spread negative on every trading day of July 2023', async () => {
    const data = await loadEventData(t.app.db, reads(['rates.term_spread_10y2y']));
    const days = tradingDays('2023-07-01', '2023-07-31');
    expect(days.length).toBe(20);
    for (const d of days) {
      const p = eventPointAt(data, spy, 'rates.term_spread_10y2y', closeOf(d), undefined);
      expect(p, d).toBeDefined();
      expect(p!.value.isNegative(), d).toBe(true);
    }
  });

  it('stores fractions exactly and keeps negative and spread values', async () => {
    const data = await loadEventData(
      t.app.db,
      reads(['rates.credit_spread_hy', 'rates.credit_spread_ig', 'rates.ust_2y']),
    );
    const at = (m: string, d: string) =>
      eventPointAt(data, spy, m, closeOf(d), undefined)?.value.toString();
    expect(at('rates.credit_spread_hy', '2025-04-07')).toBe('0.0461');
    expect(at('rates.credit_spread_ig', '2025-04-07')).toBe('0.012');
    expect(at('rates.ust_2y', '2023-10-19')).toBe('0.0514');
    // Before the series' first published day: unknown, never 0.
    expect(at('rates.credit_spread_hy', '2023-11-20')).toBeUndefined();
  });
});

describe('A3: the coverage report', () => {
  it('lists all six series with first and last dates', async () => {
    const cov = await rateCoverage(t.app.db);
    expect(cov.map((c) => c.series)).toEqual([
      'DTB3',
      'BAMLC0A0CM',
      'BAMLH0A0HYM2',
      'T10Y2Y',
      'DGS10',
      'DGS2',
    ]);
    const by = new Map(cov.map((c) => [c.series, c]));
    expect(by.get('DTB3')).toMatchObject({ first: '2024-02-01', last: '2025-04-14' });
    expect(by.get('BAMLH0A0HYM2')).toMatchObject({ first: '2023-11-21', last: '2025-04-14' });
    expect(by.get('DGS10')).toMatchObject({ first: '2016-01-04', last: '2025-04-14' });
  });

  it('counts a missing trading day as a gap, but not a weekend, holiday or bond-market holiday', async () => {
    await t.worker.db.insert(schema.ratesDaily).values([
      // A contiguous stretch with Thursday 2024-10-17 missing and Columbus Day (Mon 2024-10-14) blank.
      ...['2030-10-10', '2030-10-11', '2030-10-15', '2030-10-16', '2030-10-18'].map((date) => ({
        date,
        ust2y: '0.04',
      })),
    ]);
    const cov = (await rateCoverage(t.app.db)).find((c) => c.series === 'DGS2')!;
    expect(cov.missingTradingDays).toContain('2030-10-17');
    expect(cov.missingTradingDays).not.toContain('2030-10-14');
    expect(cov.missingTradingDays).not.toContain('2030-10-12');
    await t.ownerSql`delete from rates_daily where date >= '2030-01-01'`;
  });

  it('knows the bond-market holidays', () => {
    expect(isBondMarketHoliday('2023-10-09')).toBe(true);
    expect(isBondMarketHoliday('2023-11-10')).toBe(false);
    expect(isBondMarketHoliday('2024-11-11')).toBe(true);
    expect(isBondMarketHoliday('2025-11-12')).toBe(false);
    expect(isBondMarketHoliday('2018-11-12')).toBe(true);
  });

  it('runs in the events loop on its first pass and then only when stale', async () => {
    served.length = 0;
    let clock = new Date('2026-11-23T14:00:00Z');
    const refresher = rateSeriesRefresher({
      db: t.worker.db,
      fredUrl: FRED_URL,
      fetch: fredFetch,
      logger: quiet,
      now: () => clock,
    });
    const pass = () =>
      runEventsPass({
        db: t.worker.db,
        client: undefined,
        tickers: async () => new Map(),
        calendar: async () => [],
        refreshRates: async () => undefined,
        refreshRateSeries: refresher.refresh,
        logger: quiet,
        now: () => clock,
        symbols: [],
      });
    await pass();
    expect(served).toEqual(['BAMLC0A0CM', 'BAMLH0A0HYM2', 'T10Y2Y', 'DGS10', 'DGS2']);
    clock = new Date('2026-11-23T15:00:00Z');
    await pass();
    expect(served.length).toBe(5);
    clock = new Date('2026-11-23T21:00:00Z');
    await pass();
    expect(served.length).toBe(10);
  });

  it('records the source and when each value was stored', async () => {
    const [row] = await t.app.db
      .select()
      .from(schema.ratesDaily)
      .where(eq(schema.ratesDaily.date, '2023-10-19'));
    expect(row).toMatchObject({ source: 'fred', tbill3m: null, ust10y: '0.0498' });
    expect(row?.recordedAt).toBeInstanceOf(Date);
  });
});

describe('A4: a strategy on the high-yield spread', () => {
  const provider: HistoricalDataProvider = {
    id: 'rates-history',
    intervals: ['1d'],
    async getBars(req) {
      const bars: Bar[] = tradingDays(req.from, req.to).flatMap((d) => {
        const s = regularSession(d);
        if (!s) return [];
        const v = new Decimal(500);
        return [{ start: s.open, end: s.close, open: v, high: v, low: v, close: v, volume: v }];
      });
      return { bars, dataVersion: 'rates-history@1', warnings: [] };
    },
  };
  let n = 0;
  const metric = (id: string): Expr => ({
    kind: 'metric',
    id: `m${++n}`,
    metric: id,
    params: {},
    instrumentId: spy,
  });
  function hySpread(): StrategyDefinition {
    const def = createDefinition();
    def.entry.condition.children = [
      {
        kind: 'comparison',
        id: 'hy',
        left: metric('rates.credit_spread_hy'),
        operator: 'gt',
        right: { kind: 'constant', id: 'c1', value: '0.04' },
      },
    ];
    def.exit.condition.children = [
      {
        kind: 'comparison',
        id: 'calm',
        left: metric('rates.credit_spread_hy'),
        operator: 'lt',
        right: { kind: 'constant', id: 'c2', value: '0.035' },
      },
    ];
    const leg = {
      instrumentId: spy,
      accountId: account,
      quantity: { type: 'units' as const, value: '1', rounding: 'down' as const },
      orderType: 'market' as const,
      timeInForce: 'day' as const,
      timing: { mode: 'immediate' as const },
    };
    def.entry.trigger = { mode: 'once_per_cycle', cooldownBars: 0, confirmationBars: 0 };
    def.entry.orders = [{ id: 'buy', legLabel: 'Buy', side: 'buy', ...leg }];
    def.exit.orders = [{ id: 'sell', legLabel: 'Sell', side: 'close', ...leg }];
    return def;
  }
  const asUser = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app.db, { userId }, fn);
  const run = async (from: string, to: string) => {
    const s = await asUser((tx) =>
      createStrategy(tx, userId, { name: `hy ${from}`, definition: hySpread() }),
    );
    const r = await asUser((tx) =>
      startBacktest(tx, userId, s.id, { ...DEFAULT_BACKTEST_INPUTS, from, to }),
    );
    await processNextRun({ db: t.app.db, provider, workerId: 'w', logger: quiet });
    return asUser((tx) => getBacktest(tx, r.id));
  };

  it('is offered in the builder under rates and validates', async () => {
    expect(getMetric('rates.credit_spread_hy')).toMatchObject({
      category: 'rates',
      unit: 'fraction',
    });
    expect(getMetric('rates.credit_spread_hy')?.help).toMatch(/as currently published by FRED/);
    const ctx = await asUser((tx) => loadValidationContext(tx));
    expect(validateStrategy(hySpread(), ctx).errors).toEqual([]);
  });

  it('back tests through April 2025 without unknown-value errors and enters on the spike', async () => {
    const done = await run('2025-04-01', '2025-04-14');
    expect(done.error).toBeNull();
    expect(done.status).toBe('completed');
    const fired = done.result?.conditions?.entry.bars.filter((b) => b.outcome === 'fired') ?? [];
    expect(fired.length).toBeGreaterThan(0);
    // First above 4% on Thursday 3 April (4.01%).
    expect(new Date(fired[0]!.time).toISOString().slice(0, 10)).toBe('2025-04-03');
  });

  it('a run entirely before the series fails by name', async () => {
    const done = await run('2022-01-03', '2022-12-30');
    expect(done.status).toBe('failed');
    expect(done.error).toBe('No High-yield credit spread data before 2023-11-21');
  });
});

describe('the market-level fill of stored snapshot rows', () => {
  it('adds the regime factors to older rows once, without changing a stored value', async () => {
    const day = '2023-10-19';
    await saveFactorSnapshots(
      t.worker.db,
      [
        {
          instrumentId: spy,
          asOf: day,
          values: { return_5d: 0.01 },
          closeRet: 0,
          highRel: 0,
          lowRel: 0,
        },
      ],
      1,
    );
    // A row written after N322 already holds its values: they win.
    const other = await t.worker.db.transaction((tx) =>
      registerInstrument(tx, {
        assetClass: 'etf',
        symbol: 'QQQ',
        venue: 'NASDAQ',
        displayName: 'QQQ',
        provider: 'alpaca',
        providerId: 'QQQ-rates-test',
      }),
    );
    await saveFactorSnapshots(
      t.worker.db,
      [
        {
          instrumentId: other,
          asOf: day,
          values: { 'rates.ust_10y': 0.0498, 'rates.term_spread_10y2y': -0.0016 },
          closeRet: 0,
          highRel: 0,
          lowRel: 0,
        },
      ],
      1,
    );
    const first = await fillMarketLevel({ db: t.worker.db, logger: quiet });
    expect(first.dates).toBe(1);
    expect(first.rows).toBe(1);
    const rows = await t.ownerSql<{ instrument_id: string; values: Record<string, number> }[]>`
      select instrument_id::text, values from factor_snapshot where as_of = ${day}`;
    const mine = rows.find((r) => r.instrument_id === spy)!.values;
    expect(mine).toEqual({
      return_5d: 0.01,
      'rates.ust_10y': 0.0498,
      'rates.term_spread_10y2y': -0.0016,
      // The ICE spreads start 2023-11-21: unknown that day, left out.
    });
    const report = await factorCoverageReport(t.app.db);
    const line = (id: string) => report.factors.find((f) => f.factor === id);
    expect(line('rates.ust_10y')).toMatchObject({ known: 2, firstAny: day });
    expect(line('rates.credit_spread_hy')?.known ?? 0).toBe(0);
    // Nothing left to do: a second fill touches nothing.
    expect(await fillMarketLevel({ db: t.worker.db, logger: quiet })).toEqual({
      dates: 0,
      rows: 0,
      pending: 0,
    });
  });
});
