import {
  CONTEXT_INSTRUMENT_ID,
  createDefinition,
  FUNDAMENTAL_MAX_AGE_DAYS,
  sequentialIds,
  validateStrategy,
  type Bar,
  type Comparison,
  type ConditionGroup,
  type Expr,
  type FundamentalField,
  type FundamentalObservation,
  type MetricExpr,
  type PlannedOrder,
  type StrategyDefinition,
} from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { planSeries, seriesKey, type LoadedData } from './data';
import { simulate } from './engine';
import { dailyBars, inputs, type Row } from './test-utils';
import type { InstrumentRef } from './index';

/**
 * Acceptance checks for Design v1.2 item 6 on the brief's fixture: an S&P
 * 500 Selection group, pre-filter dividend yield above 3% and earnings
 * yield above 0, ranked by P/E ascending, top 10, rebalanced yearly from
 * 2019. Thirty made-up companies file quarterly from 2017; every selection
 * is recomputed by hand from the filings accepted before each rebalance.
 */

const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const N = 30;
const ids = Array.from({ length: N }, (_, k) => uuid(0x600 + k));
const symbols = Array.from({ length: N }, (_, k) => `CO${String(k).padStart(2, '0')}`);
const INSTRUMENTS = new Map<string, InstrumentRef>(
  ids.map((id, k) => [id, { symbol: symbols[k] as string, assetClass: 'stock', lotSize: '1' }]),
);
const DAY = 86_400_000;

/** A deterministic random walk from 2018 (enough history before a 2019 start). */
function walk(seed: number, count = 2000): Bar[] {
  let s = seed;
  const rand = () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
  let price = 40 + (seed % 90);
  const rows: Row[] = [];
  for (let i = 0; i < count; i++) {
    const close = price * (1 + (rand() - 0.5) * 0.03 + 0.0002);
    const r = (x: number) => Math.round(x * 100) / 100;
    rows.push([
      r(price),
      r(Math.max(price, close) * 1.003),
      r(Math.min(price, close) * 0.997),
      r(close),
    ]);
    price = close;
  }
  return dailyBars('2018-01-02', rows);
}
const bars = ids.map((_, k) => walk(1000 + k * 7919));

/** The trap: a filing accepted half an hour after the 2019 rebalance close. */
const TRAP = 0;
const TRAP_FILED = '2019-12-31T21:30:00.000Z';

const quarterEnds: string[] = [];
for (let y = 2017; y <= 2025; y++)
  for (const md of ['03-31', '06-30', '09-30', '12-31']) quarterEnds.push(`${y}-${md}`);

/** Each company's filings: EPS and dividends per share (TTM) and shares, 40 days after each quarter. */
function filings(k: number): FundamentalObservation[] {
  const out: FundamentalObservation[] = [];
  const price0 = (bars[k] as Bar[])[0]?.close.toNumber() ?? 50;
  quarterEnds.forEach((q, n) => {
    const end = Date.parse(`${q}T00:00:00Z`);
    // Half of the filings land during the session, half after the close.
    const hour = (k + n) % 2 === 0 ? 'T14:30:00.000Z' : 'T22:15:00.000Z';
    const availableFrom = `${new Date(end + 40 * DAY).toISOString().slice(0, 10)}${hour}`;
    if (Date.parse(availableFrom) > Date.parse('2025-12-31T00:00:00Z')) return;
    const add = (field: FundamentalField, value: number) =>
      out.push({
        field,
        value: String(Math.round(value * 10_000) / 10_000),
        periodEnd: q,
        availableFrom,
        accession: `${k}-${q}`,
        form: q.endsWith('12-31') ? '10-K' : '10-Q',
      });
    // P/E roughly 8 to 40, moving with the quarters; every seventh company loses money in 2020–21.
    let eps = (price0 / (8 + ((k * 13) % 32))) * (1 + 0.15 * Math.sin(n / 2 + k));
    if (k % 7 === 3 && q >= '2020-01-01' && q < '2022-01-01') eps = -Math.abs(eps);
    add('eps_ttm', eps);
    // Yields 0 to 6%; every fourth company pays nothing (and reports no dividends).
    if (k % 4 !== 0 && k !== TRAP) add('dps_ttm', price0 * (((k * 7) % 61) / 1000));
    add('shares', 1_000_000 + k * 1000);
  });
  if (k === TRAP) {
    // Its first dividend and a large EPS, made known just after the 2019 rebalance.
    for (const [field, value] of [
      ['dps_ttm', price0 * 0.1],
      ['eps_ttm', price0],
    ] as const) {
      out.push({
        field,
        value: String(value),
        periodEnd: '2019-12-31',
        availableFrom: TRAP_FILED,
        accession: 'trap',
        form: '10-Q',
      });
    }
  }
  return out.sort((a, b) => Date.parse(a.availableFrom) - Date.parse(b.availableFrom));
}
const FILINGS = new Map(ids.map((id, k) => [id, filings(k)]));

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;
const metric = (name: string): MetricExpr => ({
  kind: 'metric',
  id: nid('x'),
  metric: name,
  params: {},
  instrumentId: CONTEXT_INSTRUMENT_ID,
});
const cmp = (left: Expr, operator: Comparison['operator'], value: string): Comparison => ({
  kind: 'comparison',
  id: nid('cmp'),
  left,
  operator,
  right: { kind: 'constant', id: nid('c'), value },
});
const all = (...children: Comparison[]): ConditionGroup => ({
  kind: 'group',
  id: nid('g'),
  op: 'and',
  negate: false,
  children,
});
const leg = (id: string, partial: Partial<PlannedOrder> = {}): PlannedOrder => ({
  id,
  legLabel: id,
  instrumentId: CONTEXT_INSTRUMENT_ID,
  accountId: ACCOUNT,
  side: 'buy',
  quantity: { type: 'pct_equity', value: '90', rounding: 'down' },
  orderType: 'market',
  timeInForce: 'day',
  timing: { mode: 'immediate' },
  ...partial,
});

function fixture(): StrategyDefinition {
  const def = createDefinition(sequentialIds('f'));
  def.risk = {
    ...def.risk,
    maxOrderNotional: '1000000',
    maxStrategyExposure: '1000000',
    maxActiveOrders: 50,
    dailyLossLimit: '50000',
    priceCollarPct: '20',
  };
  def.trade = {
    kind: 'group',
    universe: { type: 'builtin', id: 'sp500' },
    ranking: { metric: 'pe', params: {}, direction: 'asc', count: { type: 'fixed', value: 10 } },
    splitTotal: true,
    filter: all(
      cmp(metric('dividend_yield'), 'gt', '0.03'),
      cmp(metric('earnings_yield'), 'gt', '0'),
    ),
  };
  def.entry.orders = [leg('buy-each')];
  def.exit.orders = [leg('close-each', { side: 'close' })];
  def.exit.rules = [{ kind: 'leftGroup', id: 'left' }];
  def.entry.schedule = { frequency: 'yearEnd' };
  return def;
}

/** Bars under every adjustment the run asks for (no splits here, so all alike), plus the filings. */
function data(def: StrategyDefinition, filings = FILINGS): LoadedData {
  const series = new Map<string, Bar[]>();
  for (const plan of planSeries(def, inputs('2019-01-02', '2025-06-30'), ids)) {
    const k = ids.indexOf(plan.spec.instrumentId);
    series.set(seriesKey(plan.spec), bars[k] as Bar[]);
  }
  return { series, dataVersions: ['test@1'], warnings: [], fundamentals: new Map(filings) };
}

const run = (def = fixture(), filings = FILINGS) =>
  simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs('2019-01-02', '2025-06-30'),
    data: data(def, filings),
    members: ids,
  });

/** The latest filing of a field accepted by `t`, unless it describes a period over 15 months old. */
function known(k: number, field: FundamentalField, t: number) {
  const list = (FILINGS.get(ids[k] as string) ?? []).filter(
    (o) => o.field === field && Date.parse(o.availableFrom) <= t,
  );
  const o = list.at(-1);
  if (!o || Date.parse(`${o.periodEnd}T00:00:00Z`) < t - FUNDAMENTAL_MAX_AGE_DAYS * DAY)
    return undefined;
  return o;
}

/** The selection by hand at a rebalance close `time`: qualifying stocks, 10 lowest P/E. */
function byHand(time: string): string[] {
  const t = Date.parse(time);
  const scored: { symbol: string; pe: number }[] = [];
  for (let k = 0; k < N; k++) {
    const bar = (bars[k] as Bar[]).find((b) => b.end === time);
    const eps = known(k, 'eps_ttm', t);
    const dps = known(k, 'dps_ttm', t);
    if (!bar || !eps || !dps) continue;
    const price = bar.close.toNumber();
    const e = Number(eps.value);
    if (!(Number(dps.value) / price > 0.03) || !(e / price > 0)) continue;
    scored.push({ symbol: symbols[k] as string, pe: price / e });
  }
  return scored
    .sort((a, b) => a.pe - b.pe || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, 10)
    .map((s) => s.symbol)
    .sort();
}

describe('item 6: S&P 500, dividend yield > 3% and earnings yield > 0, lowest P/E, yearly', () => {
  it('validates as built, with a company data feed', () => {
    const ctx = {
      instruments: new Map(
        ids.map((id, k) => [
          id,
          { symbol: symbols[k] as string, assetClass: 'stock', lotSize: '1' },
        ]),
      ),
      accounts: new Map([
        [
          ACCOUNT,
          {
            nickname: 'Paper',
            mode: 'paper' as const,
            isActive: true,
            capabilities: {
              assetClasses: ['stock', 'etf'],
              orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
              timeInForce: ['day', 'gtc', 'ioc', 'fok'],
              sides: ['buy', 'sell', 'sell_short', 'buy_to_cover'],
              extendedHours: true,
              shortSelling: true,
              fractionalQuantity: false,
              atomicMultiLeg: false,
            },
          },
        ],
      ]),
      hasFeed: () => true,
      now: new Date('2025-07-01T00:00:00Z'),
    } as unknown as Parameters<typeof validateStrategy>[1];
    expect(validateStrategy(fixture(), { ...ctx, hasCompanyFeed: true }).errors).toEqual([]);
    expect(
      validateStrategy(fixture(), { ...ctx, hasCompanyFeed: false }).errors.map((e) => e.code),
    ).toEqual(['missing_company_feed']);
  });

  const result = run();
  const rounds = result.selections?.rounds ?? [];

  it('rebalances at each year end and selects exactly the hand-computed 10', () => {
    expect(rounds.map((r) => r.period)).toEqual(['2019', '2020', '2021', '2022', '2023', '2024']);
    for (const round of rounds) {
      const engine = round.rows
        .filter((row) => row[4])
        .map((row) => row[0])
        .sort();
      expect(engine).toEqual(byHand(round.time));
      expect(engine.length).toBeGreaterThan(0);
    }
    expect(result.fills.length).toBeGreaterThan(10);
  });

  it('uses only filings accepted before each rebalance close (no lookahead)', () => {
    for (const round of rounds) {
      const t = Date.parse(round.time);
      for (const row of round.rows.filter((r) => r[4])) {
        const k = symbols.indexOf(row[0]);
        for (const field of ['eps_ttm', 'dps_ttm'] as const) {
          const used = known(k, field, t);
          expect(used, `${row[0]} ${field} at ${round.time}`).toBeDefined();
          expect(Date.parse(used?.availableFrom ?? '')).toBeLessThanOrEqual(t);
        }
      }
    }
    // Spot check: the trap's qualifying filing came 30 minutes after the 2019 close.
    const r2019 = rounds.find((r) => r.period === '2019');
    expect(r2019?.time).toBe('2019-12-31T21:00:00.000Z');
    const trap2019 = r2019?.rows.find((r) => r[0] === symbols[TRAP]);
    // Then it had paid no dividend (yield unknown, so the pre-filter does not pass) and its
    // P/E was the earlier filing's, not the ~1 the late filing gives.
    expect(trap2019?.[4]).toBe(false);
    expect(trap2019?.[2]).not.toBe(true);
    expect(Number(trap2019?.[1])).toBeGreaterThan(2);
    // A year later the same filing is known: the dividend passes the pre-filter.
    const r2020 = rounds.find((r) => r.period === '2020');
    expect(r2020?.rows.find((r) => r[0] === symbols[TRAP])?.[2]).toBe(true);
  });

  it('never selects a company with negative trailing earnings', () => {
    let losers = 0;
    for (const round of rounds) {
      const t = Date.parse(round.time);
      for (const row of round.rows) {
        const k = symbols.indexOf(row[0]);
        const eps = Number(known(k, 'eps_ttm', t)?.value ?? NaN);
        if (eps < 0) {
          losers++;
          expect(row[4], `${row[0]} at ${round.time}`).toBe(false);
          // P/E is unknown for a loss, so it is not ranked at all.
          expect(row[1]).toBeNull();
        }
      }
    }
    expect(losers).toBeGreaterThan(0);
  });

  it('selects nothing from fundamentals when no filings are loaded (unknown, never zero)', () => {
    const empty = run(fixture(), new Map());
    for (const round of empty.selections?.rounds ?? []) {
      expect(round.rows.filter((r) => r[4])).toEqual([]);
    }
    expect(empty.fills).toEqual([]);
  });
});
