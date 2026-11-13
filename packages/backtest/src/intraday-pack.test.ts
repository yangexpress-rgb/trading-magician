import {
  computeMetric,
  createDefinition,
  regularSession,
  sequentialIds,
  type Bar,
  type Comparison,
  type ConditionGroup,
  type Expr,
  type MarketExpr,
  type MetricExpr,
  type PositionExpr,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { seriesKey, type LoadedData } from './data';
import { simulate } from './engine';
import { MarketView } from './market';
import { A, INSTRUMENTS, compare, constant, inputs, leg, type Row } from './test-utils';

/**
 * Intraday pack acceptance fixtures (brief §7, N254–N256): session values,
 * Minutes held and Flatten at session end, with no lookahead.
 */

const FIVE = 5 * 60_000;

/** 5-minute bars of one session from `from` bars after the open. */
function fiveMinute(date: string, rows: readonly Row[], from = 0): Bar[] {
  const session = regularSession(date);
  if (!session) throw new Error(`${date} is not a trading day`);
  const open = Date.parse(session.open);
  return rows.map(([o, h, l, c, v = 1000], i) => {
    const start = open + (from + i) * FIVE;
    return {
      start: new Date(start).toISOString(),
      end: new Date(start + FIVE).toISOString(),
      open: new Decimal(o),
      high: new Decimal(h),
      low: new Decimal(l),
      close: new Decimal(c),
      volume: new Decimal(v),
    };
  });
}

/** A whole session of flat 5-minute bars at `price` (78 bars, or 42 on an early close). */
function wholeSession(date: string, price: (i: number) => number, volume = 1000): Bar[] {
  const session = regularSession(date);
  if (!session) throw new Error(`${date} is not a trading day`);
  const n = (Date.parse(session.close) - Date.parse(session.open)) / FIVE;
  return fiveMinute(
    date,
    Array.from({ length: n }, (_, i) => {
      const p = price(i);
      return [p, p + 0.5, p - 0.5, p, volume] as const;
    }),
  );
}

const key5m = seriesKey({
  instrumentId: A,
  interval: '5m',
  adjustment: 'split_and_dividend',
  session: 'regular',
});
const data5m = (bars: Bar[]): LoadedData => ({
  series: new Map([[key5m, bars]]),
  dataVersions: ['test@1'],
  warnings: [],
});

let n = 0;
const uid = (p: string) => `${p}${++n}`;
const close5m = (): MarketExpr => ({
  kind: 'market',
  id: uid('m'),
  instrumentId: A,
  field: 'close',
  interval: '5m',
  adjustment: 'split_and_dividend',
  session: 'regular',
  offset: 0,
});
const session = (metric: string, params: Record<string, number> = {}): MetricExpr => ({
  kind: 'metric',
  id: uid('s'),
  metric,
  params,
  instrumentId: A,
});
const minutesHeld = (): PositionExpr => ({
  kind: 'position',
  id: uid('p'),
  instrumentId: A,
  field: 'minutes_held',
  interval: '5m',
  adjustment: 'split_and_dividend',
  session: 'regular',
});

const at = (date: string, hhmm: string) =>
  Date.parse(new Date(`${date}T${hhmm}:00-05:00`).toISOString());
const value = (view: MarketView, metric: string, params: Record<string, number> = {}) =>
  computeMetric({ metric, params }, A, view)?.toDecimalPlaces(4).toString();

describe('session values (brief §§3–4, fixtures 3 and 4)', () => {
  it('holds the opening range fixed after the window (fixture 3)', () => {
    // 2025-03-03 is EST (UTC−5).
    const highs = [101, 103, 102, 104, 100, 102, 105];
    const lows = [99, 100, 100, 101, 99, 100, 100];
    const bars = fiveMinute(
      '2025-03-03',
      highs.map((h, i) => [100, h, lows[i] as number, 100] as const),
    );
    const view = new MarketView(data5m(bars).series);
    const range = { rangeMinutes: 30 };
    view.advance(at('2025-03-03', '09:45'));
    expect(value(view, 'session.opening_high', range)).toBe('103');
    expect(value(view, 'session.opening_low', range)).toBe('99');
    view.advance(at('2025-03-03', '10:00'));
    expect(value(view, 'session.opening_high', range)).toBe('104');
    expect(value(view, 'session.opening_low', range)).toBe('99');
    view.advance(at('2025-03-03', '10:05'));
    expect(value(view, 'session.opening_high', range)).toBe('104');
    expect(value(view, 'session.opening_low', range)).toBe('99');
    // The session high does move with the 10:05 bar.
    expect(value(view, 'session.high')).toBe('105');
    expect(value(view, 'session.low')).toBe('99');
  });

  it('accumulates the session VWAP bar by bar (fixture 4)', () => {
    const bars = fiveMinute('2025-03-03', [
      [100, 100, 100, 100, 1000],
      [102, 102, 102, 102, 500],
      [101, 101, 101, 101, 1500],
    ]);
    const view = new MarketView(data5m(bars).series);
    const expected = ['100', '100.6667', '100.8333'];
    expected.forEach((v, i) => {
      view.advance(Date.parse(bars[i]?.end as string));
      expect(value(view, 'session.vwap')).toBe(v);
    });
  });

  it('is unknown before the first session bar ends, and with no volume', () => {
    const bars = fiveMinute('2025-03-03', [[100, 101, 99, 100, 0]]);
    const view = new MarketView(data5m(bars).series);
    view.advance(at('2025-03-03', '09:34'));
    for (const id of ['session.vwap', 'session.high', 'session.opening_high'])
      expect(value(view, id)).toBeUndefined();
    view.advance(at('2025-03-03', '09:35'));
    expect(value(view, 'session.high')).toBe('101');
    expect(value(view, 'session.vwap')).toBeUndefined();
  });

  it('never mixes sessions, even after an early close (fixture 2)', () => {
    // 2025-11-28 closes at 13:00; bars after it (as if a feed sent them) must not count.
    const day1 = wholeSession('2025-11-28', () => 100);
    const late = fiveMinute('2025-11-28', [[100, 999, 1, 100, 1e9]], 42);
    const day2 = fiveMinute('2025-12-01', [
      [50, 51, 49, 50, 1000],
      [50, 52, 48, 50, 1000],
    ]);
    const view = new MarketView(data5m([...day1, ...late, ...day2]).series);
    view.advance(at('2025-11-28', '13:05'));
    expect(value(view, 'session.high')).toBe('100.5');
    expect(value(view, 'session.low')).toBe('99.5');
    expect(value(view, 'session.vwap')).toBe('100');
    view.advance(at('2025-12-01', '09:35'));
    expect(value(view, 'session.high')).toBe('51');
    expect(value(view, 'session.low')).toBe('49');
    expect(value(view, 'session.vwap')).toBe('50');
    expect(value(view, 'session.opening_high', { rangeMinutes: 5 })).toBe('51');
    view.advance(at('2025-12-01', '09:40'));
    expect(value(view, 'session.high')).toBe('52');
    expect(value(view, 'session.opening_high', { rangeMinutes: 5 })).toBe('51');
  });
});

/** Enter once on any bar; Exit when `exit` holds (none when empty); 5-minute bars. */
function intraday(exit: Comparison[], patch: Partial<StrategyDefinition['execution']> = {}) {
  const def = createDefinition(sequentialIds('g'));
  def.entry.condition.children = [compare(close5m(), 'gt', constant('0'))];
  // Fire whenever true, so a cycle opens on the first bar and again after each close.
  def.entry.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
  def.entry.orders = [leg('e')];
  def.exit.condition.children = exit;
  def.exit.orders = [leg('x', { side: 'close' })];
  def.execution = { ...def.execution, ...patch };
  return def;
}

describe('no lookahead (fixture 1)', () => {
  it('records the same session values and minutes held up to T when later bars change', () => {
    const never = (e: Expr) => compare(e, 'lt', constant('-1'));
    const def = intraday([
      never(session('session.vwap')),
      never(session('session.high')),
      never(session('session.low')),
      never(session('session.opening_high', { rangeMinutes: 30 })),
      never(session('session.opening_low', { rangeMinutes: 30 })),
      never(minutesHeld()),
    ]);
    // Every check is recorded, so an AND of falsehoods still lists each value.
    (def.exit.condition as ConditionGroup).op = 'or';
    const day1 = wholeSession('2025-03-03', (i) => 100 + (i % 7));
    const day2 = wholeSession('2025-03-04', (i) => 95 + (i % 5), 2000);
    const T = at('2025-03-04', '11:00');
    const run = (bars: Bar[]) =>
      simulate({
        definition: def,
        instruments: INSTRUMENTS,
        inputs: inputs('2025-03-03', '2025-03-04', { interval: '5m' }),
        data: data5m(bars),
      });
    const before = run([...day1, ...day2]);
    const mutated = [
      ...day1,
      ...day2.map((b) =>
        Date.parse(b.end) <= T
          ? b
          : {
              ...b,
              open: b.open.times(3),
              high: b.high.times(5),
              low: b.low.div(5),
              close: b.close.times(2),
              volume: b.volume.times(1000),
            },
      ),
    ];
    const after = run(mutated);
    const upTo = (r: typeof before) =>
      r.conditions!.exit.bars.filter((b) => Date.parse(b.time) <= T && b.time >= '2025-03-04');
    const rows = upTo(before);
    expect(rows.length).toBeGreaterThan(15);
    // Session 2's values are all known at T, and minutes held keeps counting.
    const last = rows.at(-1);
    expect(last?.checks.filter((c) => c.left !== undefined && c.left !== null)).toHaveLength(6);
    expect(JSON.stringify(upTo(after))).toBe(JSON.stringify(rows));
    // The later bars did change what came after T.
    expect(JSON.stringify(after.conditions!.exit.bars)).not.toBe(
      JSON.stringify(before.conditions!.exit.bars),
    );
  });
});

describe('minutes held (brief §5, fixture 5)', () => {
  it('fires "Minutes held ≥ 30" at the bar ending 10:10 after a fill at 09:40', () => {
    // Entry decides at the bar ending 09:40 and fills at the next bar's open, 09:40.
    const bars = wholeSession('2025-03-03', (i) => (i < 1 ? 100 : 101));
    const def = intraday([compare(minutesHeld(), 'gte', constant('30'))]);
    def.entry.condition.children = [compare(close5m(), 'gt', constant('100.5'))];
    const result = simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs('2025-03-03', '2025-03-03', { interval: '5m' }),
      data: data5m(bars),
    });
    expect(result.trades[0]?.entryTime).toBe(new Date(at('2025-03-03', '09:40')).toISOString());
    const row = (hhmm: string) =>
      result.conditions!.exit.bars.find(
        (b) => b.time === new Date(at('2025-03-03', hhmm)).toISOString(),
      );
    expect(row('10:05')?.checks.find((c) => c.left !== undefined)?.left).toBe('25');
    expect(row('10:05')?.truth).toBe(false);
    expect(row('10:10')?.checks.find((c) => c.left !== undefined)?.left).toBe('30');
    expect(row('10:10')?.truth).toBe(true);
    expect(result.conditions!.exit.bars.find((b) => b.truth === true)?.time).toBe(
      new Date(at('2025-03-03', '10:10')).toISOString(),
    );
  });
});

describe('Flatten at session end (brief §6a, fixture 6)', () => {
  const run = (def: StrategyDefinition, bars: Bar[], from: string, to: string) =>
    simulate({
      definition: def,
      instruments: INSTRUMENTS,
      inputs: inputs(from, to, { interval: '5m' }),
      data: data5m(bars),
    });

  it('closes at the last bar of a normal session with reason "Session end", with no Exit when', () => {
    const bars = [
      ...wholeSession('2025-03-03', (i) => 100 + i / 10),
      ...wholeSession('2025-03-04', (i) => 110 + i / 10),
    ];
    const result = run(
      intraday([], { flattenAtSessionEnd: true }),
      bars,
      '2025-03-03',
      '2025-03-04',
    );
    expect(result.trades).toHaveLength(2);
    for (const [i, day] of ['2025-03-03', '2025-03-04'].entries()) {
      const t = result.trades[i];
      expect(t?.status).toBe('closed');
      expect(t?.exitReason).toBe('session_end');
      expect(t?.exitTime).toBe(regularSession(day)?.close);
      // Same day: no position held overnight.
      expect(t?.entryTime?.slice(0, 10)).toBe(day);
    }
    // Closed at that bar's close (77th bar: 100 + 7.7), less 5 bps slippage on a sale.
    const exitLeg = result.trades[0]?.legs.find((l) => l.phase === 'flatten');
    const close = new Decimal(100 + 77 / 10);
    expect(exitLeg?.averagePrice).toBe(
      close
        .times(new Decimal(1).minus(new Decimal(5).div(10_000)))
        .toDecimalPlaces(4)
        .toString(),
    );
  });

  it('closes at 13:00 on an early-close day', () => {
    const bars = [
      ...wholeSession('2025-11-28', () => 100),
      ...wholeSession('2025-12-01', () => 101),
    ];
    const result = run(
      intraday([], { flattenAtSessionEnd: true }),
      bars,
      '2025-11-28',
      '2025-12-01',
    );
    const first = result.trades[0];
    expect(first?.exitReason).toBe('session_end');
    expect(first?.exitTime).toBe(new Date(at('2025-11-28', '13:00')).toISOString());
    expect(result.trades[1]?.exitTime).toBe(regularSession('2025-12-01')?.close);
  });

  it('holds overnight with the toggle off', () => {
    const bars = [
      ...wholeSession('2025-03-03', () => 100),
      ...wholeSession('2025-03-04', () => 101),
    ];
    const result = run(intraday([]), bars, '2025-03-03', '2025-03-04');
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0]?.status).toBe('open');
    expect(result.trades[0]?.exitReason).toBeUndefined();
  });

  it('runs after Exit when, and never closes a position twice', () => {
    const sold = (r: ReturnType<typeof run>) =>
      r.trades[0]?.legs.filter((l) => l.side !== 'buy').reduce((s, l) => s + Number(l.quantity), 0);
    // Exit when fires on the bar ending 15:55: its order fills on the last bar, so nothing is left.
    const early = run(
      intraday([compare(close5m(), 'gt', constant('110'))], { flattenAtSessionEnd: true }),
      wholeSession('2025-03-03', (i) => (i < 76 ? 100 : 120)),
      '2025-03-03',
      '2025-03-03',
    );
    expect(early.trades[0]?.exitReason).toBe('condition');
    expect(sold(early)).toBe(10);
    // Exit when fires on the last bar: its order could only fill tomorrow, so the
    // session end cancels it and closes the position at 16:00.
    const late = run(
      intraday([compare(close5m(), 'gt', constant('110'))], { flattenAtSessionEnd: true }),
      wholeSession('2025-03-03', (i) => (i < 77 ? 100 : 120)),
      '2025-03-03',
      '2025-03-03',
    );
    expect(late.trades[0]?.exitReason).toBe('session_end');
    expect(late.trades[0]?.exitTime).toBe(regularSession('2025-03-03')?.close);
    expect(sold(late)).toBe(10);
    expect(late.trades[0]?.status).toBe('closed');
  });
});
