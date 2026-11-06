import {
  cboeBars,
  createDefinition,
  nyDate,
  parseCboeHistory,
  regularSession,
  sequentialIds,
  tradingDays,
  validateStrategy,
  type Bar,
  type Comparison,
  type Expr,
  type MarketExpr,
  type PlannedOrder,
  type StatExpr,
  type StrategyDefinition,
} from '@tm/domain';
import { describe, expect, it } from 'vitest';
import { planSeries } from './data';
import { simulate } from './engine';
import { spyBars } from './fixtures/spy-strategies';
import { inputs, loaded } from './test-utils';
import type { InstrumentRef } from './index';

/**
 * Acceptance checks for Design v1.2 item 5: a non-tradable index (the VIX)
 * watched by a strategy that trades SPY, and the BandWidth function. VIX bars
 * go through the same CBOE parsing and calendar alignment the feed uses.
 */

const ACCOUNT = '00000000-0000-4000-8000-0000000000a1';
const SPY = '00000000-0000-4000-8000-0000000005b1';
const VIX = '00000000-0000-4000-8000-000000000f1c';
const INSTRUMENTS = new Map<string, InstrumentRef>([
  [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
  [VIX, { symbol: 'VIX', assetClass: 'index', lotSize: '1' }],
]);

let seq = 0;
const nid = (p: string) => `${p}${++seq}`;
const close = (instrumentId: string): MarketExpr => ({
  kind: 'market',
  id: nid('m'),
  instrumentId,
  field: 'close',
  interval: '1d',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset: 0,
});
const band = (fn: StatExpr['fn'], input: Expr = close(VIX)): StatExpr => ({
  kind: 'stat',
  id: nid('s'),
  fn,
  input,
  period: 20,
  multiplier: '2',
});
const cmp = (left: Expr, operator: Comparison['operator'], right: Expr): Comparison => ({
  kind: 'comparison',
  id: nid('c'),
  left,
  operator,
  right,
});
const leg = (id: string, partial: Partial<PlannedOrder> = {}): PlannedOrder => ({
  id,
  legLabel: id,
  instrumentId: SPY,
  accountId: ACCOUNT,
  side: 'buy',
  quantity: { type: 'pct_equity', value: '90', rounding: 'down' },
  orderType: 'market',
  timeInForce: 'day',
  extendedHours: false,
  timing: { mode: 'immediate' },
  timingOnly: false,
  ...partial,
});

const spy = spyBars(700, 41);
const DAYS = tradingDays('2023-01-03', '2030-12-31').slice(0, spy.length);

/**
 * A VIX-like history in CBOE's CSV format over the same days: mean-reverting
 * with spikes, missing every 37th trading day, plus a value on each Good
 * Friday (the NYSE is closed then).
 */
function vixCsv(): { csv: string; missing: Set<string> } {
  let s = 99;
  const rand = () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
  const rows = ['DATE,OPEN,HIGH,LOW,CLOSE'];
  const missing = new Set<string>();
  const us = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}/${d.slice(0, 4)}`;
  let x = Math.log(18);
  DAYS.forEach((d, i) => {
    if (i % 37 === 20) {
      missing.add(d);
      return;
    }
    const open = Math.exp(x);
    x += 0.08 * (Math.log(18) - x) + 0.06 * (rand() - 0.5) * 2 + (rand() < 0.03 ? 0.3 : 0);
    const c = Math.exp(x);
    const r = (v: number) => v.toFixed(2);
    rows.push(
      [us(d), r(open), r(Math.max(open, c) * 1.02), r(Math.min(open, c) * 0.98), r(c)].join(','),
    );
  });
  for (const gf of ['2023-04-07', '2024-03-29', '2025-04-18'])
    rows.push(`${us(gf)},20.00,21.00,19.00,20.50`);
  return { csv: rows.join('\n'), missing };
}

const { csv, missing } = vixCsv();
const parsed = parseCboeHistory(csv);
const aligned = cboeBars(parsed.days, '2023-01-01', '2026-12-31', new Date('2027-01-01T00:00:00Z'));
const vix: Bar[] = aligned.bars;

/** The brief's fixture: buy SPY when VIX closes above its 20-bar upper band; exit below the middle. */
function vixFixture(): StrategyDefinition {
  const def = createDefinition(sequentialIds('v'));
  def.risk = {
    ...def.risk,
    maxOrderNotional: '1000000',
    maxStrategyExposure: '1000000',
    dailyLossLimit: '50000',
  };
  def.entry.condition.children = [cmp(close(VIX), 'gt', band('BB_UPPER'))];
  def.entry.orders = [leg('buy')];
  def.exit.condition.children = [cmp(close(VIX), 'lt', band('BB_MIDDLE'))];
  def.exit.orders = [leg('sell', { side: 'close' })];
  return def;
}

/** The latest VIX bar ending at or before `t`: "most recent close on or before". */
const vixAsOf = (t: number) => {
  let i = -1;
  while (i + 1 < vix.length && Date.parse((vix[i + 1] as Bar).end) <= t) i++;
  return i;
};
/** Upper band from the stored VIX bars, population deviation as BBANDS. */
const upperByHand = (i: number) => {
  const xs = vix.slice(i - 19, i + 1).map((b) => b.close.toNumber());
  const mean = xs.reduce((a, x) => a + x, 0) / 20;
  const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / 20);
  return mean + 2 * sd;
};

describe('item 5: CBOE history aligned to the US trading calendar', () => {
  it('drops values on days the NYSE was closed and keeps the gaps CBOE left', () => {
    expect(aligned.dropped.sort()).toEqual(['2023-04-07', '2024-03-29', '2025-04-18']);
    const days = new Set(vix.map((b) => nyDate(b.start)));
    for (const d of missing) expect(days.has(d)).toBe(false);
    for (const b of vix) {
      const s = regularSession(nyDate(b.start));
      expect(s && b.end === s.close && b.start === s.open).toBe(true);
    }
  });
});

describe('item 5: VIX above its upper Bollinger band → buy SPY (2 years)', () => {
  const def = vixFixture();
  const run = simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs('2023-03-01', '2025-02-28'),
    data: loaded({ [SPY]: spy, [VIX]: vix }),
  });

  it('validates with VIX as a condition instrument', () => {
    const v = validateStrategy(def, {
      instruments: new Map([
        [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1', venue: 'ARCA' }],
        [VIX, { symbol: 'VIX', assetClass: 'index', lotSize: '1', venue: 'CBOE' }],
      ]),
      accounts: new Map([
        [
          ACCOUNT,
          {
            nickname: 'Paper',
            mode: 'paper',
            isActive: true,
            capabilities: {
              assetClasses: ['stock', 'etf'],
              orderTypes: ['market', 'limit'],
              timeInForce: ['day', 'gtc'],
              sides: ['buy', 'sell', 'sell_short'],
              extendedHours: false,
              shortSelling: true,
              fractionalQuantity: false,
              atomicMultiLeg: false,
            },
          },
        ],
      ]),
      hasFeed: () => true,
      now: new Date('2026-11-06T12:00:00Z'),
    });
    expect(v.errors).toEqual([]);
  });

  it('enters at least once, and every entry bar has VIX above its 20-bar upper band', () => {
    const entries = run.trades.filter((t) => t.entryTime);
    expect(entries.length).toBeGreaterThan(0);
    for (const t of entries) {
      // Decided at the previous SPY close; filled at this bar's open.
      const spyIndex = spy.findIndex((b) => b.start === t.entryTime) - 1;
      const decidedAt = Date.parse((spy[spyIndex] as Bar).end);
      const i = vixAsOf(decidedAt);
      expect((vix[i] as Bar).close.toNumber()).toBeGreaterThan(upperByHand(i));
    }
  });

  it('reads the most recent VIX close on a day CBOE published nothing', () => {
    // Every day SPY traded but VIX is missing is still evaluated (never stale).
    expect(run.conditions?.entry.unknownBars).toBe(0);
    expect([...missing].some((d) => d >= '2023-03-01' && d <= '2025-02-28')).toBe(true);
    // Read like a stock's bars instead, the missing days would make VIX stale (unknown).
    const asStock = simulate({
      definition: def,
      instruments: new Map([
        ...INSTRUMENTS,
        [VIX, { symbol: 'VIX', assetClass: 'etf', lotSize: '1' }],
      ]),
      inputs: inputs('2023-03-01', '2025-02-28'),
      data: loaded({ [SPY]: spy, [VIX]: vix }),
    });
    expect(asStock.conditions?.entry.unknownBars).toBeGreaterThan(0);
  });

  it('never trades VIX and never sets the clock from it', () => {
    expect(run.fills.every((f) => f.symbol === 'SPY')).toBe(true);
    const plans = planSeries(
      def,
      inputs('2023-03-01', '2025-02-28', { interval: '1h' }),
      [],
      new Set([VIX]),
    );
    const vixPlans = plans.filter((p) => p.spec.instrumentId === VIX);
    expect(vixPlans.map((p) => p.spec.interval)).toEqual(['1d']);
  });
});

describe('item 5: BANDWIDTH through the statistic machinery', () => {
  it('equals (upper − lower) / middle on every bar, for any expression input', () => {
    const def = vixFixture();
    const bw = band('BANDWIDTH');
    const byBands: Expr = {
      kind: 'calc',
      id: nid('k'),
      op: 'div',
      args: [
        { kind: 'calc', id: nid('k'), op: 'sub', args: [band('BB_UPPER'), band('BB_LOWER')] },
        band('BB_MIDDLE'),
      ],
    };
    // |BANDWIDTH − (upper − lower) / middle| is tiny: the two are computed in different orders.
    const diff: Expr = {
      kind: 'calc',
      id: nid('k'),
      op: 'abs',
      args: [{ kind: 'calc', id: nid('k'), op: 'sub', args: [bw, byBands] }],
    };
    def.entry.condition.children = [
      cmp(diff, 'lt', { kind: 'constant', id: nid('c'), value: '0.000000001' }),
    ];
    def.entry.trigger = { mode: 'while_true', cooldownSec: 0, confirmationBars: 0 };
    def.exit.condition.children = [
      cmp(close(SPY), 'lt', { kind: 'constant', id: nid('c'), value: '0' }),
    ];
    const r = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2023-03-01', '2024-12-31'),
      data: loaded({ [SPY]: spy, [VIX]: vix }),
    });
    expect(r.conditions?.entry.falseBars).toBe(0);
    expect(r.conditions?.entry.trueBars).toBeGreaterThan(300);
  });
});
