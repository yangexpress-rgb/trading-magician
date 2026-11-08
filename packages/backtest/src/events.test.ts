import {
  createDefinition,
  emptyEventData,
  regularSession,
  sequentialIds,
  tradingDays,
  type Bar,
  type Comparison,
  type DealSignal,
  type EarningsSignal,
  type EventData,
  type Expr,
  type MetricExpr,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { seriesKey, type InstrumentRef, type LoadedData } from './data';
import { simulate } from './engine';
import {
  dealsBeforeFirstDate,
  earningsBeforeFirstDate,
  ratesBeforeFirstDate,
} from './events-coverage';
import { ACCOUNT, inputs, leg } from './test-utils';

/**
 * The Lab fixtures of the free data feeds brief v1 §7 and §10: PEAD (entry
 * days since earnings ≤ 5 and SUE > 1.0, 60-bar time stop), merger
 * arbitrage (spread > 3%, exit when the deal stops producing a spread or
 * after 120 days) and dual momentum against the T-bill instead of 0, back
 * tested over February 2024 – November 2026 on stand-in data.
 */

const XYZ = '00000000-0000-4000-8000-0000000000e1';
const TGT = '00000000-0000-4000-8000-0000000000e2';
const SPY = '00000000-0000-4000-8000-0000000000e3';
const INSTRUMENTS = new Map<string, InstrumentRef>([
  [XYZ, { symbol: 'XYZ', assetClass: 'stock', lotSize: '1' }],
  [TGT, { symbol: 'TGT', assetClass: 'stock', lotSize: '1' }],
  [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
]);
const FROM = '2024-02-01';
const TO = '2026-11-06';

let n = 0;
const uid = (p: string) => `${p}${++n}`;
const metric = (id: string, instrumentId: string, params: MetricExpr['params'] = {}): MetricExpr => ({
  kind: 'metric',
  id: uid('x'),
  metric: id,
  params,
  instrumentId,
});
const constant = (value: string): Expr => ({ kind: 'constant', id: uid('c'), value });
const cmp = (left: Expr, operator: Comparison['operator'], right?: Expr): Comparison => ({
  kind: 'comparison',
  id: uid('cmp'),
  left,
  operator,
  ...(right ? { right } : {}),
});

/** Daily bars on every trading day in the window: flat at `price(day)`. */
function bars(price: (day: string, i: number) => number, from = '2023-01-03'): Bar[] {
  return tradingDays(from, TO).map((d, i) => {
    const s = regularSession(d)!;
    const v = new Decimal(price(d, i));
    return { start: s.open, end: s.close, open: v, high: v, low: v, close: v, volume: new Decimal(1e6) };
  });
}

/** Both the adjusted and the unadjusted daily series (event metrics date bars by the raw close). */
function data(series: Record<string, Bar[]>, events: EventData): LoadedData {
  const map = new Map<string, Bar[]>();
  for (const [id, b] of Object.entries(series))
    for (const adjustment of ['split_and_dividend', 'none'] as const)
      map.set(seriesKey({ instrumentId: id, interval: '1d', adjustment, session: 'regular' }), b);
  return { series: map, dataVersions: ['test@1'], warnings: [], events };
}

/**
 * Event metrics are unknown, not false, before the first release or deal, so
 * "fire on the change to true" would miss the first one: the fixtures fire
 * once per cycle whenever the condition holds.
 */
const buySell = (def: StrategyDefinition, id: string) => {
  def.entry.trigger = { mode: 'once_per_cycle', cooldownBars: 0, confirmationBars: 0 };
  def.entry.orders = [leg('buy', { instrumentId: id })];
  def.exit.orders = [leg('sell', { instrumentId: id, side: 'close' })];
};

// ---------------------------------------------------------------------------
// PEAD

function peadFixture(): StrategyDefinition {
  const def = createDefinition(sequentialIds('pead'));
  def.entry.condition.children = [
    cmp(metric('earnings.days_since_earnings', XYZ), 'lte', constant('5')),
    cmp(metric('earnings.sue_ts', XYZ), 'gt', constant('1.0')),
  ];
  // Exit by the time stop alone: the exit condition never holds.
  def.exit.condition.children = [cmp(metric('earnings.days_since_earnings', XYZ), 'lt', constant('-1'))];
  def.exit.rules = [{ kind: 'timeStop', id: 'ts', barsHeld: 60 }];
  buySell(def, XYZ);
  return def;
}

/** XYZ reports each quarter on a Monday after the close; every other quarter has SUE 2.50. */
function xyzReleases(): EarningsSignal[] {
  const out: EarningsSignal[] = [];
  const mondays = tradingDays('2024-02-01', TO).filter(
    (d) => new Date(`${d}T12:00:00Z`).getUTCDay() === 1 && ['02', '05', '08', '11'].includes(d.slice(5, 7)) && Number(d.slice(8)) <= 7,
  );
  mondays.forEach((d, i) =>
    out.push({
      fiscalQuarterEnd: d,
      announcedAt: `${d}T21:05:00.000Z`,
      announcedDate: d,
      reportedEps: 2.5,
      sue: i % 2 === 0 ? 2.5 : 0.4,
      surprisePct: null,
      source: d < '2026-11-08' ? 'rebuilt' : 'recorded',
    }),
  );
  return out;
}

describe('PEAD fixture (§7.1, §10 item 1)', () => {
  const releases = xyzReleases();
  const events: EventData = { ...emptyEventData(), earnings: new Map([[XYZ, releases]]) };

  it('back tests over February 2024 – November 2026 without a "no data" error', () => {
    expect(earningsBeforeFirstDate('XYZ', events, XYZ, TO)).toBeUndefined();
    const r = simulate({
      definition: peadFixture(),
      instruments: INSTRUMENTS,
      inputs: inputs(FROM, TO),
      data: data({ [XYZ]: bars((_, i) => 100 + i * 0.05) }, events),
    });
    const strong = releases.filter((x) => (x.sue ?? 0) > 1);
    expect(r.trades.length).toBeGreaterThan(0);
    // One entry per strong release (each held 60 bars, so no overlap), none on a weak one.
    expect(r.trades.length).toBe(strong.length);
    for (const t of r.trades) {
      const day = t.entryTime!.slice(0, 10);
      const rel = strong.find((x) => x.announcedDate < day && day <= addDays(x.announcedDate, 7));
      expect(rel, `entry ${day} follows a strong release`).toBeDefined();
    }
    const closed = r.trades.filter((t) => t.status === 'closed');
    expect(closed.every((t) => t.exitReason === 'time_stop')).toBe(true);
    expect(r.warnings.some((w) => w.code === `earnings_coverage:${XYZ}`)).toBe(true);
  });

  it('fails a run entirely before February 2024 with the named message', () => {
    expect(earningsBeforeFirstDate('XYZ', events, XYZ, '2023-12-29')).toBe(
      `No earnings data for XYZ before ${releases[0]!.announcedDate}`,
    );
    expect(earningsBeforeFirstDate('AAPL', emptyEventData(), 'aapl', TO)).toBe(
      'No earnings data for AAPL yet: the recording starts with the next release',
    );
  });
});

const addDays = (d: string, k: number) =>
  new Date(Date.parse(`${d}T00:00:00Z`) + k * 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------------------
// Merger arbitrage

function mergerArbFixture(): StrategyDefinition {
  const def = createDefinition(sequentialIds('arb'));
  def.entry.condition.children = [cmp(metric('deals.spread_pct', TGT), 'gt', constant('0.03'))];
  // Exit once the deal produces no spread (closed or withdrawn), or after 120 days.
  def.exit.condition.op = 'or';
  def.exit.condition.children = [
    {
      kind: 'group',
      id: 'no-deal',
      op: 'and',
      negate: true,
      children: [cmp(metric('deals.spread_pct', TGT), 'is_available')],
    },
  ];
  def.exit.rules = [{ kind: 'timeStop', id: 'ts', barsHeld: 120 }];
  buySell(def, TGT);
  return def;
}

describe('merger-arbitrage fixture (§7.2, §10 item 2)', () => {
  const deal: DealSignal = {
    dealId: 'D00001',
    announcedAt: '2025-03-03T11:30:00.000Z',
    offerPrice: 50,
    confidence: 'high',
    changes: [
      { date: '2025-04-15', status: 'pending' },
      { date: '2025-06-02', status: 'closed' },
    ],
  };
  const events: EventData = {
    ...emptyEventData(),
    deals: new Map([[TGT, [deal]]]),
    dealsFrom: '2024-02-01',
  };
  const tgtBars = bars((d) => (d < '2025-03-03' ? 40 : 47.5));

  it('enters at the 5.26% spread and exits the day after the deal closes', () => {
    expect(dealsBeforeFirstDate(events, TO)).toBeUndefined();
    const r = simulate({
      definition: mergerArbFixture(),
      instruments: INSTRUMENTS,
      inputs: inputs(FROM, TO),
      data: data({ [TGT]: tgtBars }, events),
    });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0]!;
    expect(t.entryTime!.slice(0, 10) >= '2025-03-03').toBe(true);
    expect(t.status).toBe('closed');
    expect(t.exitReason).toBe('condition');
    // The spread stops on 2025-06-03, the trading day after closing: the exit is decided then.
    expect(t.exitTime!.slice(0, 10) >= '2025-06-03').toBe(true);
    expect(t.exitTime!.slice(0, 10) <= '2025-06-05').toBe(true);
    const entry = r.conditions?.entry.bars.find((b) => b.outcome === 'fired');
    expect(JSON.stringify(entry)).toContain('deal D00001 of 2025-03-03');
  });

  it('never enters on a low-confidence parse: the spread stays null, not zero', () => {
    const low: EventData = { ...events, deals: new Map([[TGT, [{ ...deal, confidence: 'low' }]]]) };
    const r = simulate({
      definition: mergerArbFixture(),
      instruments: INSTRUMENTS,
      inputs: inputs(FROM, TO),
      data: data({ [TGT]: tgtBars }, low),
    });
    expect(r.trades).toHaveLength(0);
  });

  it('fails a run before the tracker covers the dates', () => {
    expect(dealsBeforeFirstDate(events, '2023-12-29')).toBe('No deal data before 2024-02-01');
    expect(dealsBeforeFirstDate(emptyEventData(), TO)).toMatch(/^No deal data yet/);
  });
});

// ---------------------------------------------------------------------------
// Dual momentum with the T-bill hurdle

function dualMomentum(hurdle: 'zero' | 'tbill'): StrategyDefinition {
  const def = createDefinition(sequentialIds(`dm-${hurdle}`));
  const ret = () => metric('return', SPY, { lookbackMonths: '12', skipMonths: '0' });
  const bar = hurdle === 'zero' ? constant('0') : metric('rates.tbill_3m', SPY);
  def.entry.condition.children = [cmp(ret(), 'gt', bar)];
  def.exit.condition.children = [
    cmp(ret(), 'lte', hurdle === 'zero' ? constant('0') : metric('rates.tbill_3m', SPY)),
  ];
  buySell(def, SPY);
  return def;
}

describe('dual-momentum fixture with the T-bill hurdle (§7.3, §10 item 3)', () => {
  // DTB3 4.12% throughout; SPY gains 3% a year, so it beats 0 but never the T-bill.
  const rates = tradingDays('2023-01-03', TO).map((date) => ({ date, tbill3m: 0.0412 }));
  const events: EventData = { ...emptyEventData(), rates };
  const spy = bars((_, i) => 400 * 1.03 ** (i / 252));
  const run = (h: 'zero' | 'tbill') =>
    simulate({
      definition: dualMomentum(h),
      instruments: INSTRUMENTS,
      inputs: inputs('2024-11-06', '2026-11-05'),
      data: data({ [SPY]: spy }, events),
    });

  it('compares the 12-month return with 0.0412 instead of 0', () => {
    expect(ratesBeforeFirstDate(events, '2026-11-05')).toBeUndefined();
    const zero = run('zero');
    const tbill = run('tbill');
    expect(zero.trades.length).toBeGreaterThan(0);
    expect(tbill.trades).toHaveLength(0);
    const read = tbill.conditions?.entry.bars[0];
    expect(JSON.stringify(read)).toContain('0.0412');
    expect(JSON.stringify(read)).toContain('T-bill 2024-11-06');
  });

  it('fails before the first stored rate', () => {
    expect(ratesBeforeFirstDate(events, '2022-12-30')).toBe('No T-bill rates before 2023-01-03');
  });
});
