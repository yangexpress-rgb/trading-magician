import {
  CONTEXT_INSTRUMENT_ID,
  createDefinition,
  parseDefinition,
  nyDate,
  sequentialIds,
  validateStrategy,
  type Bar,
  type Comparison,
  type ConditionGroup,
  type Expr,
  type IndicatorExpr,
  type MarketExpr,
  type MetricExpr,
  type PlannedOrder,
  type StatExpr,
  type StrategyDefinition,
} from '@tm/domain';
import type Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import {
  breakoutDonchian,
  meanReversionRsi2,
  spyBars,
  trendSma200,
} from './fixtures/spy-strategies';
import { behaviour } from './corpus-codec';
import { inputs, loaded } from './test-utils';
import type { BacktestResult, InstrumentRef } from './index';

/**
 * Acceptance checks for Design v1.2 P0 (items 1–4), on the brief's own
 * example configurations. Prices are deterministic random walks, so every
 * expected value below is recomputed by hand from the same bars.
 */

const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;

const market = (instrumentId: string, field: MarketExpr['field'] = 'close'): MarketExpr => ({
  kind: 'market',
  id: nid('m'),
  instrumentId,
  field,
  interval: '1d',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset: 0,
});
const indicator = (
  instrumentId: string,
  name: string,
  params: IndicatorExpr['params'],
): IndicatorExpr => ({ ...market(instrumentId), kind: 'indicator', name, params });
const metric = (
  instrumentId: string,
  name: string,
  params: MetricExpr['params'] = {},
): MetricExpr => ({ kind: 'metric', id: nid('x'), metric: name, params, instrumentId });
const constant = (value: string): Expr => ({ kind: 'constant', id: nid('c'), value });
const cmp = (left: Expr, operator: Comparison['operator'], right: Expr): Comparison => ({
  kind: 'comparison',
  id: nid('cmp'),
  left,
  operator,
  right,
});
const all = (...children: Comparison[]): ConditionGroup => ({
  kind: 'group',
  id: nid('g'),
  op: 'and',
  negate: false,
  children,
});
const leg = (
  id: string,
  instrumentId: string,
  partial: Partial<PlannedOrder> = {},
): PlannedOrder => ({
  id,
  legLabel: id,
  instrumentId,
  accountId: ACCOUNT,
  side: 'buy',
  quantity: { type: 'pct_equity', value: '90', rounding: 'down' },
  orderType: 'market',
  timeInForce: 'day',
  timing: { mode: 'immediate' },
  ...partial,
});

const BIG_RISK = {
  maxOrderNotional: '1000000',
  maxStrategyExposure: '1000000',
  maxActiveOrders: 50,
  dailyLossLimit: '50000',
  priceCollarPct: '20',
};

function baseDefinition(): StrategyDefinition {
  const def = createDefinition(sequentialIds('d'));
  def.risk = { ...def.risk, ...BIG_RISK };
  return def;
}

const closesOf = (bars: readonly Bar[]) => bars.map((b) => b.close.toNumber());

function replayPositions(r: BacktestResult): Map<string, Map<string, number>> {
  // Holdings after each fill time, by symbol.
  const held = new Map<string, number>();
  const at = new Map<string, Map<string, number>>();
  for (const f of r.fills) {
    const q = Number(f.quantity) * (f.side === 'buy' ? 1 : -1);
    held.set(f.symbol, (held.get(f.symbol) ?? 0) + q);
    at.set(f.time, new Map(held));
  }
  return at;
}

// ---------------------------------------------------------------------------
// Item 1: universe ranking with top-N selection (+ item 4 fixture a)
// ---------------------------------------------------------------------------

const SECTORS = ['XLB', 'XLE', 'XLF', 'XLI', 'XLK', 'XLP', 'XLU', 'XLV', 'XLY'];
const sectorIds = SECTORS.map((_, i) => uuid(0x100 + i));
const sectorBars = SECTORS.map((_, i) => spyBars(900, 101 + i * 17));
const SECTOR_INSTRUMENTS = new Map<string, InstrumentRef>(
  SECTORS.map((s, i) => [sectorIds[i] as string, { symbol: s, assetClass: 'etf', lotSize: '1' }]),
);

/** The brief's fixture: top 3 of 9 sector ETFs by 6-month return, above their 200-day SMA. */
function sectorFixture(schedule?: 'monthEnd'): StrategyDefinition {
  const def = baseDefinition();
  def.trade = {
    kind: 'group',
    universe: { type: 'list', instrumentIds: sectorIds },
    ranking: {
      metric: 'return',
      params: { lookbackMonths: '6', skipMonths: '0' },
      direction: 'desc',
      count: { type: 'fixed', value: 3 },
    },
    // The leg's amount is the total, split over the 3 picks, as these hand checks assume.
    splitTotal: true,
    filter: all(
      cmp(
        market(CONTEXT_INSTRUMENT_ID),
        'gt',
        indicator(CONTEXT_INSTRUMENT_ID, 'SMA', { period: 200 }),
      ),
    ),
  };
  def.entry.orders = [leg('buy-each', CONTEXT_INSTRUMENT_ID)];
  def.exit.orders = [leg('close-each', CONTEXT_INSTRUMENT_ID, { side: 'close' })];
  // Holdings that drop out of the top 3 are sold at the next check (ADR 0073).
  def.exit.rules = [{ kind: 'leftGroup', id: 'left' }];
  if (schedule) def.entry.schedule = { frequency: schedule };
  return def;
}

function setFilter(def: StrategyDefinition, filter: ConditionGroup) {
  if (def.trade.kind === 'group') def.trade.filter = filter;
}

const runSectors = (def: StrategyDefinition, bars = sectorBars) =>
  simulate({
    definition: def,
    instruments: SECTOR_INSTRUMENTS,
    inputs: inputs('2023-06-01', '2025-06-30'),
    data: loaded(Object.fromEntries(sectorIds.map((id, i) => [id, bars[i] as Bar[]]))),
    members: sectorIds,
  });

/** The top 3 by hand: 6-month (126-bar) return among ETFs closing above their 200-day SMA. */
function topThreeByHand(time: string, bars = sectorBars): string[] {
  const scored: { symbol: string; ret: number }[] = [];
  SECTORS.forEach((symbol, k) => {
    const series = bars[k] as Bar[];
    const i = series.findIndex((b) => b.end === time);
    if (i < 199 || i < 126) return;
    const c = closesOf(series);
    const sma = c.slice(i - 199, i + 1).reduce((a, x) => a + x, 0) / 200;
    if (!((c[i] as number) > sma)) return;
    scored.push({ symbol, ret: (c[i] as number) / (c[i - 126] as number) - 1 });
  });
  return scored
    .sort((a, b) => b.ret - a.ret || (a.symbol < b.symbol ? -1 : 1))
    .slice(0, 3)
    .map((s) => s.symbol)
    .sort();
}

describe('item 1: Selection group, top 3 of 9 sector ETFs', () => {
  it('validates as built', () => {
    const def = sectorFixture('monthEnd');
    const v = validateStrategy(def, {
      instruments: new Map(
        sectorIds.map((id, i) => [
          id,
          { symbol: SECTORS[i] as string, assetClass: 'etf', lotSize: '1', venue: 'ARCA' },
        ]),
      ),
      accounts: new Map([
        [
          ACCOUNT,
          {
            nickname: 'Paper',
            mode: 'paper',
            isActive: true,
            capabilities: {
              assetClasses: ['stock', 'etf'],
              orderTypes: ['market', 'limit', 'stop', 'stop_limit'],
              timeInForce: ['day', 'gtc'],
              sides: ['buy', 'sell', 'sell_short', 'buy_to_cover'],
              extendedHours: false,
              shortSelling: true,
              fractionalQuantity: false,
              atomicMultiLeg: false,
              coverage: 'us',
            },
          },
        ],
      ]),
      hasFeed: () => true,
      now: new Date('2026-11-06T15:00:00Z'),
    });
    expect(v.errors).toEqual([]);
  });

  it('holds exactly the hand-computed top 3 after every monthly rebalance', () => {
    const r = runSectors(sectorFixture('monthEnd'));
    const rounds = r.selections?.rounds ?? [];
    // 25 month ends from June 2023 to June 2025.
    expect(rounds.length).toBeGreaterThanOrEqual(24);
    const positions = replayPositions(r);
    let checked = 0;
    for (const round of rounds) {
      const engine = round.rows
        .filter((row) => row[4])
        .map((row) => row[0])
        .sort();
      expect(engine).toEqual(topThreeByHand(round.time));
      // Holdings once the next bar's fills are done are exactly the selection.
      const i = (sectorBars[0] as Bar[]).findIndex((b) => b.end === round.time);
      const nextOpen = (sectorBars[0] as Bar[])[i + 1]?.start;
      if (!nextOpen || (round.entered.length === 0 && round.exited.length === 0)) continue;
      const held = [...(positions.get(nextOpen) ?? new Map<string, number>())]
        .filter(([, q]) => q !== 0)
        .map(([s]) => s)
        .sort();
      expect(held).toEqual(engine);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('exports a ranking table that checks by hand against the bars', () => {
    const r = runSectors(sectorFixture('monthEnd'));
    const round = r.selections?.rounds[6];
    expect(round).toBeDefined();
    if (!round) return;
    for (const [symbol, value, filter, rank] of round.rows) {
      const k = SECTORS.indexOf(symbol);
      const c = closesOf(sectorBars[k] as Bar[]);
      const i = (sectorBars[k] as Bar[]).findIndex((b) => b.end === round.time);
      const ret = (c[i] as number) / (c[i - 126] as number) - 1;
      expect(Number(value)).toBeCloseTo(ret, 10);
      const sma = c.slice(i - 199, i + 1).reduce((a, x) => a + x, 0) / 200;
      expect(filter).toBe((c[i] as number) > sma);
      expect(rank === null).toBe(!filter);
    }
  });

  it('trades only on the bar after a month-end evaluation', () => {
    const r = runSectors(sectorFixture('monthEnd'));
    const evaluated = new Set((r.selections?.rounds ?? []).map((x) => nyDate(x.time)));
    for (const f of r.fills) {
      const i = (sectorBars[0] as Bar[]).findIndex((b) => b.start === f.time);
      const decided = (sectorBars[0] as Bar[])[i - 1]?.end;
      expect(decided && evaluated.has(nyDate(decided))).toBe(true);
    }
  });

  it('re-selects on every bar on the daily schedule, without churn', () => {
    const r = runSectors(sectorFixture());
    expect(r.trades.length).toBeGreaterThan(0);
    // A member still selected is kept: no cycle closes and reopens the same symbol on one bar.
    const bySymbolDay = new Map<string, string[]>();
    for (const f of r.fills) {
      const key = `${f.symbol}|${f.time}`;
      bySymbolDay.set(key, [...(bySymbolDay.get(key) ?? []), f.side]);
    }
    for (const sides of bySymbolDay.values()) expect(new Set(sides).size).toBe(1);
  });

  it('leaves out a member with too little history, with the reason, never ranking it at 0', () => {
    const short = [...sectorBars];
    short[4] = (sectorBars[4] as Bar[]).slice(500); // XLK starts ~2 years in: no 6-month return early on
    const r = runSectors(sectorFixture('monthEnd'), short);
    const early = r.selections?.rounds[0];
    const xlk = early?.rows.find((row) => row[0] === 'XLK');
    expect(xlk?.[1]).toBeNull();
    expect(xlk?.[3]).toBeNull();
    expect(xlk?.[4]).toBe(false);
    expect(['no_value', 'filter_unknown']).toContain(xlk?.[5]);
    expect(r.warnings.some((w) => w.code === 'selection_no_value' || w.code === 'stale_data')).toBe(
      true,
    );
  });

  it('holds only the members that pass when fewer than N pass, and cash when none do', () => {
    const def = sectorFixture('monthEnd');
    // Only members more than 30% above their 200-day average qualify: rarely anyone.
    setFilter(
      def,
      all(
        cmp(metric(CONTEXT_INSTRUMENT_ID, 'ma_distance', { period: 200 }), 'gt', constant('0.30')),
      ),
    );
    const r = runSectors(def);
    for (const round of r.selections?.rounds ?? []) {
      const passing = round.rows.filter((row) => row[2] === true).length;
      expect(round.rows.filter((row) => row[4]).length).toBe(Math.min(3, passing));
    }
  });

  it('still fires a risk exit in the middle of a month', () => {
    const def = sectorFixture('monthEnd');
    def.exit.condition.children = [
      cmp(
        {
          kind: 'position',
          id: nid('p'),
          instrumentId: CONTEXT_INSTRUMENT_ID,
          field: 'gain_pct',
          interval: '1d',
          adjustment: 'split_and_dividend',
          session: 'regular',
        },
        'lt',
        constant('-3'),
      ),
    ];
    const r = runSectors(def);
    const monthEnds = new Set((r.selections?.rounds ?? []).map((x) => nyDate(x.time)));
    const midMonth = r.trades.filter(
      (t) => t.exitReason === 'condition' && t.exitTime && !monthEnds.has(prevDay(t.exitTime)),
    );
    expect(midMonth.length).toBeGreaterThan(0);
  });

  it('back tests the fixed-instrument strategies exactly as before', () => {
    const spy = '00000000-0000-4000-8000-0000000005b1';
    const run = (definition: StrategyDefinition) =>
      simulate({
        definition,
        instruments: new Map([[spy, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }]]),
        inputs: inputs('2023-11-01', '2025-06-30'),
        data: loaded({ [spy]: spyBars() }),
      });
    // Behaviour fingerprints from before the Strategy Lab simplification (see regression.test.ts).
    expect(behaviour(run(trendSma200()))).toBe('359f3c8d617a2e6e');
    expect(behaviour(run(meanReversionRsi2()))).toBe('28a9842e5ab84767');
    expect(behaviour(run(breakoutDonchian()))).toBe('c4e0ad1ba4caff45');
  });
});

function prevDay(time: string): string {
  const bars = sectorBars[0] as Bar[];
  const i = bars.findIndex((b) => b.start === time);
  return nyDate((bars[i - 1] as Bar).end);
}

// ---------------------------------------------------------------------------
// Item 2: per-leg conditions
// ---------------------------------------------------------------------------

const SPY = uuid(0x201);
const EFA = uuid(0x202);
const AGG = uuid(0x203);
const RISK3 = [
  [SPY, 'SPY'],
  [EFA, 'EFA'],
  [AGG, 'AGG'],
] as const;

/** Three walks; around the middle all three fall for months, so every 12-month return turns negative. */
function threeAssetBars(): Record<string, Bar[]> {
  const out: Record<string, Bar[]> = {};
  RISK3.forEach(([id], k) => {
    const base = spyBars(900, 300 + k * 41);
    // A long, shared decline: from bar 450 to 700 every close falls 0.25% a day relative to the walk.
    out[id] = base.map((b, i) => {
      const f = i < 450 ? 1 : Math.pow(0.9965, Math.min(i, 700) - 450);
      const m = (x: Decimal) => x.times(f).toDecimalPlaces(2);
      return { ...b, open: m(b.open), high: m(b.high), low: m(b.low), close: m(b.close) };
    });
  });
  return out;
}

const ret12 = (id: string) => metric(id, 'return', { lookbackMonths: '12', skipMonths: '0' });

/** The brief's fixture: each leg qualifies when its own 12-month return beats the others' and 0. */
function dualMomentum(schedule: 'monthEnd' | undefined = 'monthEnd'): StrategyDefinition {
  const def = baseDefinition();
  const ids = RISK3.map(([id]) => id);
  def.entry.orders = RISK3.map(([id, symbol]) =>
    leg(`buy-${symbol}`, id, {
      legCondition: all(
        ...ids.filter((o) => o !== id).map((o) => cmp(ret12(id), 'gt', ret12(o))),
        cmp(ret12(id), 'gt', constant('0')),
      ),
    }),
  );
  def.exit.orders = RISK3.map(([id, symbol]) => leg(`sell-${symbol}`, id, { side: 'close' }));
  if (schedule) def.entry.schedule = { frequency: schedule };
  return def;
}

const run3 = (def: StrategyDefinition) =>
  simulate({
    definition: def,
    instruments: new Map(
      RISK3.map(([id, s]) => [id, { symbol: s, assetClass: 'etf', lotSize: '1' }]),
    ),
    inputs: inputs('2023-01-03', '2025-06-30'),
    data: loaded(threeAssetBars()),
  });

describe('item 2: per-leg conditions, SPY / EFA / AGG', () => {
  it('never holds two at once, and holds none while all three returns are negative', () => {
    const r = run3(dualMomentum());
    expect(r.trades.length).toBeGreaterThan(1);
    const positions = replayPositions(r);
    for (const holdings of positions.values()) {
      expect([...holdings.values()].filter((q) => q !== 0).length).toBeLessThanOrEqual(1);
    }
    // Rounds where every leg condition was false (all returns negative) leave the portfolio empty.
    const bars = threeAssetBars();
    const spyBarsList = bars[SPY] as Bar[];
    let emptyChecked = 0;
    for (const round of r.selections?.rounds ?? []) {
      const i = spyBarsList.findIndex((b) => b.end === round.time);
      const negatives = RISK3.every(([id]) => {
        const c = closesOf(bars[id] as Bar[]);
        return (c[i] as number) / (c[i - 252] as number) - 1 < 0;
      });
      if (!negatives) continue;
      expect(round.rows.every((row) => row[2] === false)).toBe(true);
      const next = spyBarsList[i + 2]?.start;
      const held = [...(positions.get(next ?? '') ?? new Map())].filter(([, q]) => q !== 0);
      // Whatever was held has been sold by the next open.
      const after = [...positions.entries()]
        .filter(([t]) => t <= (spyBarsList[i + 1]?.start ?? ''))
        .at(-1)?.[1];
      expect([...(after ?? new Map()).values()].every((q) => q === 0)).toBe(true);
      void held;
      emptyChecked += 1;
    }
    expect(emptyChecked).toBeGreaterThan(0);
  });

  it('works on the daily schedule too: entry-only, still never two at once', () => {
    const r = run3(dualMomentum(undefined));
    for (const holdings of replayPositions(r).values()) {
      expect([...holdings.values()].filter((q) => q !== 0).length).toBeLessThanOrEqual(1);
    }
  });

  it('a Selection group of these legs (formerly best-by-metric) fires only the strongest qualifying leg', () => {
    const def = baseDefinition();
    def.entry.condition.children = [cmp(market(SPY), 'gt', constant('0'))];
    def.entry.orders = RISK3.map(([id, s]) =>
      leg(`buy-${s}`, id, { quantity: { type: 'pct_equity', value: '30', rounding: 'down' } }),
    );
    // Schema 2's ranked legs, kept as saved (ADR 0073).
    def.entry.rankedLegs = {
      metric: 'return',
      params: { lookbackMonths: '12' },
      direction: 'desc',
      count: { type: 'fixed', value: 1 },
    };
    def.exit.orders = RISK3.map(([id, s]) => leg(`sell-${s}`, id, { side: 'close' }));
    def.entry.schedule = { frequency: 'monthEnd' };
    const r = run3(def);
    for (const round of r.selections?.rounds ?? []) {
      const selected = round.rows.filter((row) => row[4]);
      expect(selected.length).toBeLessThanOrEqual(1);
      if (selected[0]) {
        const best = Math.max(
          ...round.rows.filter((row) => row[1] !== null).map((row) => Number(row[1])),
        );
        expect(Number(selected[0][1])).toBe(best);
      }
    }
  });

  it('fires both legs of a two-leg strategy with no leg conditions, as before', async () => {
    const { twoLegs, SPY: spy, QQQ } = await import('./fixtures/spy-strategies');
    const r = simulate({
      definition: twoLegs(),
      instruments: new Map([
        [spy, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
        [QQQ, { symbol: 'QQQ', assetClass: 'etf', lotSize: '1' }],
      ]),
      inputs: inputs('2023-11-01', '2025-06-30'),
      data: loaded({ [spy]: spyBars(), [QQQ]: spyBars(640, 11) }),
    });
    expect(behaviour(r)).toBe('0199ca63e0450e45');
  });
});

// ---------------------------------------------------------------------------
// Item 3: standard deviation and z-score on a calculated expression
// ---------------------------------------------------------------------------

const PEP = uuid(0x301);
const KO = uuid(0x302);

/** PEP tracks KO plus a mean-reverting spread with occasional shocks. */
function pairBars(): Record<string, Bar[]> {
  const ko = spyBars(800, 55).map((b) => b);
  let s = 3;
  const rand = () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
  let spread = 20;
  const pep = ko.map((b, i) => {
    spread = 20 + (spread - 20) * 0.92 + (rand() - 0.5) * 1.2 + (i % 97 === 50 ? -9 : 0);
    const shift = (x: Decimal) => x.div(4).plus(spread).toDecimalPlaces(2);
    return {
      ...b,
      open: shift(b.open),
      high: shift(b.high),
      low: shift(b.low),
      close: shift(b.close),
    };
  });
  const koScaled = ko.map((b) => {
    const q = (x: Decimal) => x.div(4).toDecimalPlaces(2);
    return { ...b, open: q(b.open), high: q(b.high), low: q(b.low), close: q(b.close) };
  });
  return { [PEP]: pep, [KO]: koScaled };
}

const spreadExpr = (): Expr => ({
  kind: 'calc',
  id: nid('s'),
  op: 'sub',
  args: [market(PEP), market(KO)],
});
const z60 = (): StatExpr => ({
  kind: 'stat',
  id: nid('z'),
  fn: 'ZSCORE',
  input: spreadExpr(),
  period: 60,
});

describe('item 3: z-score of the PEP − KO spread', () => {
  const def = baseDefinition();
  def.entry.condition.children = [cmp(z60(), 'lt', constant('-2'))];
  def.entry.orders = [
    leg('buy-pep', PEP, { quantity: { type: 'units', value: '100', rounding: 'down' } }),
  ];
  def.exit.condition.children = [cmp(z60(), 'gt', constant('0'))];
  def.exit.orders = [leg('sell-pep', PEP, { side: 'close' })];
  const data = pairBars();
  const r = simulate({
    definition: def,
    instruments: new Map([
      [PEP, { symbol: 'PEP', assetClass: 'stock', lotSize: '1' }],
      [KO, { symbol: 'KO', assetClass: 'stock', lotSize: '1' }],
    ]),
    inputs: inputs('2023-06-01', '2025-06-30'),
    data: loaded(data),
  });

  /** The z-score computed outside the engine: sample deviation over the last 60 spreads. */
  const zByHand = (i: number) => {
    const p = closesOf(data[PEP] as Bar[]);
    const k = closesOf(data[KO] as Bar[]);
    const xs = Array.from({ length: 60 }, (_, j) => (p[i - j] as number) - (k[i - j] as number));
    const mean = xs.reduce((a, x) => a + x, 0) / 60;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / 59);
    return ((xs[0] as number) - mean) / sd;
  };

  it('enters only on bars where the 60-bar z-score is below −2, at least once', () => {
    const entries = r.trades.filter((t) => t.entryTime);
    expect(entries.length).toBeGreaterThan(0);
    const pep = data[PEP] as Bar[];
    for (const t of entries.slice(0, 3)) {
      const i = pep.findIndex((b) => b.start === t.entryTime) - 1; // decided at the previous close
      expect(zByHand(i)).toBeLessThan(-2);
    }
  });

  it('exits once the z-score is back above 0', () => {
    const pep = data[PEP] as Bar[];
    for (const t of r.trades.filter((x) => x.exitTime).slice(0, 3)) {
      const i = pep.findIndex((b) => b.start === t.exitTime) - 1;
      expect(zByHand(i)).toBeGreaterThan(0);
    }
  });

  it('keeps Bollinger bands on a single price identical to the v1.1 indicator', () => {
    const spy = '00000000-0000-4000-8000-0000000005b1';
    const bars = spyBars();
    const view = { values: new Map<string, Bar[]>() };
    void view;
    for (const band of ['upper', 'middle', 'lower'] as const) {
      const fn = band === 'upper' ? 'BB_UPPER' : band === 'middle' ? 'BB_MIDDLE' : 'BB_LOWER';
      const d = baseDefinition();
      const bb: StatExpr = {
        kind: 'stat',
        id: nid('b'),
        fn,
        input: market(spy),
        period: 20,
        multiplier: '2',
      };
      const old = indicator(spy, 'BBANDS', { period: 20, stdDev: 2, band });
      // Entry when the generalised band equals the indicator: every bar with a value.
      d.entry.condition.children = [cmp(bb, 'eq', old)];
      d.entry.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
      d.entry.orders = [
        leg('b', spy, { quantity: { type: 'units', value: '1', rounding: 'down' } }),
      ];
      d.exit.condition.children = [cmp(market(spy), 'lt', constant('0'))];
      d.exit.orders = [leg('s', spy, { side: 'close' })];
      const res = simulate({
        definition: d,
        instruments: new Map([[spy, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }]]),
        inputs: inputs('2023-03-01', '2023-12-29'),
        data: loaded({ [spy]: bars }),
      });
      const report = res.conditions?.entry;
      expect(report?.falseBars).toBe(0);
      expect(report?.trueBars).toBeGreaterThan(150);
    }
  });
});

// ---------------------------------------------------------------------------
// Item 4: holding-period exit
// ---------------------------------------------------------------------------

describe('item 4: RSI(2) below 10, exit above SMA(5) or after 5 trading days', () => {
  const spy = '00000000-0000-4000-8000-0000000005b1';
  const bars = spyBars(900, 23);
  const build = (withStop: boolean) => {
    const d = baseDefinition();
    d.entry.condition.children = [cmp(indicator(spy, 'RSI', { period: 2 }), 'lt', constant('10'))];
    d.entry.orders = [
      leg('buy', spy, { quantity: { type: 'units', value: '10', rounding: 'down' } }),
    ];
    // A price exit that rarely triggers quickly: close 3% above SMA(5).
    d.exit.condition.children = [
      cmp(market(spy), 'gt', {
        kind: 'calc',
        id: nid('k'),
        op: 'mul',
        args: [indicator(spy, 'SMA', { period: 5 }), constant('1.03')],
      }),
    ];
    d.exit.orders = [leg('sell', spy, { side: 'close' })];
    if (withStop) d.exit.rules = [{ kind: 'timeStop', id: 'ts', barsHeld: 5 }];
    return d;
  };
  const run = (d: StrategyDefinition) =>
    simulate({
      definition: d,
      instruments: new Map([[spy, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }]]),
      inputs: inputs('2023-06-01', '2025-06-30'),
      data: loaded({ [spy]: bars }),
    });

  it('holds no position longer than 5 bars, and price exits still come earlier', () => {
    const r = run(build(true));
    const index = (t: string) => bars.findIndex((b) => b.start === t);
    const closed = r.trades.filter((t) => t.status === 'closed');
    expect(closed.length).toBeGreaterThan(3);
    for (const t of closed) {
      const held = index(t.exitTime as string) - index(t.entryTime as string);
      expect(held).toBeLessThanOrEqual(5);
      if (t.exitReason === 'time_stop') expect(held).toBe(5);
      else expect(t.exitReason).toBe('condition');
    }
    expect(closed.some((t) => t.exitReason === 'time_stop')).toBe(true);
    // Without the stop some positions are held much longer.
    const without = run(build(false)).trades.filter((t) => t.status === 'closed');
    expect(
      without.some((t) => index(t.exitTime as string) - index(t.entryTime as string) > 5),
    ).toBe(true);
  });
});

describe('a Selection group that keeps its picks (ADR 0059)', () => {
  it('never sells on a rebalance and exits only by its own rules', () => {
    const base = runSectors(sectorFixture('monthEnd'));
    expect(base.trades.some((t) => t.exitReason === 'rebalance')).toBe(true);
    const def = sectorFixture('monthEnd');
    // No "Left the group" rule: each pick is kept until its own exit.
    def.exit.rules = [{ kind: 'trailingStop', id: 'ts', percent: '3' }];
    const r = runSectors(def);
    expect(r.trades.some((t) => t.exitReason === 'rebalance')).toBe(false);
    expect(r.trades.some((t) => t.exitReason === 'trailing_stop')).toBe(true);
  });
});

describe('What to trade, Entry, Exit (ADR 0073)', () => {
  const sellsDecidedOn = (r: BacktestResult) =>
    r.fills
      .filter((f) => f.side !== 'buy')
      .map((f) => {
        const i = (sectorBars[0] as Bar[]).findIndex((b) => b.start === f.time);
        return (sectorBars[0] as Bar[])[i - 1]?.end ?? '';
      });

  it('checks Exit only on its own schedule', () => {
    const def = sectorFixture();
    // Each pick is kept, and Exit when is always true: without a schedule it exits every bar.
    def.exit.rules = [];
    def.exit.condition = all(cmp(market(CONTEXT_INSTRUMENT_ID), 'gt', constant('0')));
    const everyBar = runSectors(def);
    def.exit.schedule = { frequency: 'monthEnd' };
    const monthly = runSectors(def);
    expect(monthly.trades.length).toBeGreaterThan(0);
    expect(monthly.trades.length).toBeLessThan(everyBar.trades.length);
    const monthEnds = new Set(
      (runSectors(sectorFixture('monthEnd')).selections?.rounds ?? []).map((x) => nyDate(x.time)),
    );
    const decided = sellsDecidedOn(monthly);
    expect(decided.length).toBeGreaterThan(0);
    for (const d of decided) expect(monthEnds.has(nyDate(d))).toBe(true);
  });

  it('holds every member that passes the filter when the group has no ranking', () => {
    const def = sectorFixture('monthEnd');
    if (def.trade.kind === 'group') delete def.trade.ranking;
    def.trade = { ...def.trade, splitTotal: false } as typeof def.trade;
    def.entry.orders = [
      leg('buy-each', CONTEXT_INSTRUMENT_ID, {
        quantity: { type: 'pct_equity', value: '10', rounding: 'down' },
      }),
    ];
    def.risk = { ...def.risk, maxInstrumentsHeld: 9 };
    const r = runSectors(def);
    const rounds = r.selections?.rounds ?? [];
    expect(rounds.length).toBeGreaterThan(20);
    const positions = replayPositions(r);
    let checked = 0;
    for (const round of rounds) {
      const passing = round.rows
        .filter((row) => row[2])
        .map((row) => row[0])
        .sort();
      const i = (sectorBars[0] as Bar[]).findIndex((b) => b.end === round.time);
      const nextOpen = (sectorBars[0] as Bar[])[i + 1]?.start;
      if (!nextOpen || (round.entered.length === 0 && round.exited.length === 0)) continue;
      const held = [...(positions.get(nextOpen) ?? new Map<string, number>())]
        .filter(([, q]) => q !== 0)
        .map(([s]) => s)
        .sort();
      expect(held).toEqual(passing);
      checked += 1;
    }
    expect(checked).toBeGreaterThan(3);
  });

  it('back tests a schema 2 Selection group exactly as its schema 3 form', () => {
    const v3 = sectorFixture('monthEnd');
    if (v3.trade.kind !== 'group' || !v3.trade.ranking) throw new Error('fixture');
    const { ranking, universe, filter } = v3.trade;
    const doc = JSON.parse(JSON.stringify(v3)) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    doc.schemaVersion = 2;
    delete doc.trade;
    doc.schedule = doc.entry.schedule;
    delete doc.entry.schedule;
    doc.exit.rules = [];
    doc.entry.kind = 'selection';
    doc.entry.selection = {
      universe,
      ranking: { metric: ranking.metric, params: ranking.params },
      direction: ranking.direction,
      count: ranking.count,
      preFilter: filter,
    };
    const migrated = parseDefinition(doc);
    // The 90% total over 3 picks is now 30% per pick, with no split.
    expect(migrated.entry.orders[0]?.quantity.value).toBe('30');
    expect(behaviour(runSectors(migrated))).toEqual(behaviour(runSectors(v3)));
  });
});

describe('why each pick was picked (N217 to N219)', () => {
  it("records each new pick's filter values, ranking and the run's three parts", () => {
    const def = sectorFixture('monthEnd');
    // A calculated side: close above 1.0 × its own close one bar ago.
    const prev = { ...market(CONTEXT_INSTRUMENT_ID), id: nid('prev'), offset: 1 };
    const calc: Expr = { kind: 'calc', id: nid('calc'), op: 'mul', args: [prev, constant('0')] };
    setFilter(
      def,
      all(
        cmp(
          market(CONTEXT_INSTRUMENT_ID),
          'gt',
          indicator(CONTEXT_INSTRUMENT_ID, 'SMA', { period: 200 }),
        ),
        cmp(market(CONTEXT_INSTRUMENT_ID), 'gt', calc),
      ),
    );
    const r = runSectors(def);
    expect(r.plan).toMatchObject({
      trade: {
        kind: 'group',
        universe: { type: 'list', size: 9 },
        ranking: { metric: 'return', direction: 'desc', count: { type: 'fixed', value: 3 } },
      },
      entrySchedule: 'monthEnd',
      exitSchedule: null,
      perCandidate: false,
    });
    const picks = (r.cycles ?? []).filter((c) => c.pick);
    expect(picks.length).toBeGreaterThan(0);
    for (const d of picks) {
      const p = d.pick!;
      const round = r.selections!.rounds.find((x) => x.time === p.time)!;
      const row = round.rows.find((x) => x[0] === p.symbol)!;
      expect(round.entered).toContain(p.symbol);
      expect([p.value, p.rank]).toEqual([row[1], row[3]]);
      expect(p.members).toBe(9);
      expect(p.rank).toBeLessThanOrEqual(3);
      expect(p.filter?.truth).toBe(true);
      // Every comparison with its values, and the close the calculation multiplied.
      const [above, rising] = (
        def.trade.kind === 'group' ? def.trade.filter!.children : []
      ) as Comparison[];
      const a = p.filter!.checks.find((c) => c.id === above!.id)!;
      expect(Number(a.left)).toBeGreaterThan(Number(a.right));
      const b = p.filter!.checks.find((c) => c.id === rising!.id)!;
      expect(Number(b.right)).toBe(0);
      expect(Number(b.inputs?.[prev.id])).toBeGreaterThan(0);
    }
    // The records explain the run and change none of it.
    const { plan: _plan, ...bare } = r;
    void _plan;
    expect(behaviour(r)).toBe(behaviour({ ...bare, cycles: [] }));
  });
});
