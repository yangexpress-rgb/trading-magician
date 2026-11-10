import {
  parseDefinition,
  regularSession,
  tradingDays,
  type Bar,
  trailingPeak,
  trailingStopHit,
  trailingStopLevel,
  type StrategyDefinition,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { simulate } from './engine';
import { riskAtrTrend, SPY, spyBars } from './fixtures/spy-strategies';
import { seriesKey } from './data';
import {
  A,
  close,
  compare,
  constant,
  INSTRUMENTS as TEST_INSTRUMENTS,
  inputs,
  leg,
  loaded,
  strategy,
} from './test-utils';
import type { InstrumentRef } from './index';

/**
 * The trailing stop (ADR 0059): from the entry price it follows the best daily
 * close since entry, and a close more than the percent off that peak exits.
 */

const INSTRUMENTS = new Map<string, InstrumentRef>([
  [SPY, { symbol: 'SPY', assetClass: 'etf', lotSize: '1' }],
]);

function trailing(percent: string): StrategyDefinition {
  const def = riskAtrTrend();
  def.exit.rules = [{ kind: 'trailingStop', id: 'ts', percent }];
  def.exit.condition.children = [];
  return def;
}

const bars = spyBars();
const run = (def: StrategyDefinition) =>
  simulate({
    definition: def,
    instruments: INSTRUMENTS,
    inputs: inputs('2023-11-01', '2025-06-30'),
    data: loaded({ [SPY]: bars }),
  });

describe('the trailing stop level', () => {
  it('is 1% under the peak for a long and over it for a short', () => {
    expect(trailingStopLevel(new Decimal(100), '1', true).toString()).toBe('99');
    expect(trailingStopLevel(new Decimal(100), '1', false).toString()).toBe('101');
    expect(trailingStopHit(new Decimal(98.99), new Decimal(99), true)).toBe(true);
    expect(trailingStopHit(new Decimal(99), new Decimal(99), true)).toBe(false);
    expect(trailingStopHit(new Decimal(101.01), new Decimal(101), false)).toBe(true);
  });
  it('only moves the peak in the position’s favour', () => {
    expect(trailingPeak(new Decimal(100), new Decimal(103), true).toString()).toBe('103');
    expect(trailingPeak(new Decimal(103), new Decimal(101), true).toString()).toBe('103');
    expect(trailingPeak(new Decimal(100), new Decimal(97), false).toString()).toBe('97');
    expect(trailingPeak(new Decimal(97), new Decimal(99), false).toString()).toBe('97');
  });
});

describe('a back test with a trailing stop', () => {
  it('exits on the first close more than 1% below the best close since entry', () => {
    const r = run(trailing('1'));
    const exits = r.trades.filter((t) => t.exitReason === 'trailing_stop');
    expect(exits.length).toBeGreaterThan(0);
    for (const t of exits) {
      const entry = bars.findIndex((b) => b.start === t.entryTime);
      const fill = bars.findIndex((b) => b.start === t.exitTime);
      // Walk the closes from the entry bar to the bar the exit was decided on.
      let peak = new Decimal(t.legs.find((l) => l.phase === 'entry')!.averagePrice!);
      let firedAt = -1;
      for (let i = entry; i < fill; i++) {
        const close = bars[i]!.close;
        if (close.lt(peak.times(0.99))) {
          firedAt = i;
          break;
        }
        if (close.gt(peak)) peak = close;
      }
      // The exit fills at the open after the first close past the level.
      expect(firedAt).toBe(fill - 1);
    }
    expect(r.assumptions.some((a) => a.includes('trailing stop'))).toBe(true);
  });

  it('holds longer with a wider trail', () => {
    const tight = run(trailing('1')).trades.filter((t) => t.exitReason === 'trailing_stop');
    const wide = run(trailing('8')).trades.filter((t) => t.exitReason === 'trailing_stop');
    const held = (ts: typeof tight) =>
      ts.reduce((n, t) => n + (Date.parse(t.exitTime!) - Date.parse(t.entryTime!)), 0) /
      Math.max(ts.length, 1);
    expect(wide.length).toBeLessThan(tight.length);
    expect(held(wide)).toBeGreaterThan(held(tight));
  });
});

describe('the trailing stop as an Exit when condition (N217, ADR 0074)', () => {
  /** The saved form: schema 3, with the rule, and an Exit that fires on any check it holds. */
  const saved = (percent: string) => {
    const def = trailing(percent);
    def.exit.trigger = { mode: 'while_true', cooldownBars: 0, confirmationBars: 0 };
    return { ...JSON.parse(JSON.stringify(def)), schemaVersion: 3 } as Record<string, unknown>;
  };

  it('reads a saved rule as "Off best close since entry % > N" and exits on the same closes', () => {
    for (const percent of ['1', '3']) {
      const doc = saved(percent);
      const asCondition = parseDefinition(doc);
      expect(asCondition.exit.rules ?? []).toEqual([]);
      expect(JSON.stringify(asCondition.exit.condition)).toContain('off_peak_pct');
      // The rule as it ran before: the same strategy, rule kept, read as schema 4.
      const asRule = parseDefinition({ ...doc, schemaVersion: 4 });
      expect(asRule.exit.rules?.[0]?.kind).toBe('trailingStop');
      const a = run(asRule);
      const b = run(asCondition);
      expect(a.trades.some((t) => t.exitReason === 'trailing_stop')).toBe(true);
      const fills = (r: typeof a) => r.fills.map((f) => [f.time, f.side, f.quantity, f.price]);
      expect(fills(b)).toEqual(fills(a));
      // The exits now read as Exit when, with the value in the bar check.
      expect(b.trades.some((t) => t.exitReason === 'trailing_stop')).toBe(false);
    }
  });

  it('keeps the rule as saved where Fire when could hold the condition back', () => {
    const doc = saved('1');
    (doc.exit as { trigger: unknown }).trigger = {
      mode: 'on_transition',
      cooldownBars: 0,
      confirmationBars: 0,
    };
    expect(parseDefinition(doc).exit.rules?.[0]?.kind).toBe('trailingStop');
  });
});

describe('stops read no close from before Entry filled (N225)', () => {
  it('an hourly Entry is not stopped out by the previous day’s daily close', () => {
    const days = tradingDays('2024-03-04', '2024-03-08');
    const bar = (start: number, end: number, px: number): Bar => ({
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      open: new Decimal(px),
      high: new Decimal(px),
      low: new Decimal(px),
      close: new Decimal(px),
      volume: new Decimal(1_000_000),
    });
    // Day 1 closes at 100; from day 2 the stock trades at 110 all day.
    const price = (i: number) => (i === 0 ? 100 : 110);
    const hourly: Bar[] = [];
    const daily: Bar[] = [];
    days.forEach((d, i) => {
      const s = regularSession(d)!;
      const open = Date.parse(s.open);
      const close = Date.parse(s.close);
      for (let t = open; t < close; t += 3_600_000)
        hourly.push(bar(t, Math.min(t + 3_600_000, close), price(i)));
      daily.push(bar(open, close, price(i)));
    });
    const key = (interval: '1h' | '1d') =>
      seriesKey({
        instrumentId: A,
        interval,
        adjustment: 'split_and_dividend',
        session: 'regular',
      });
    const hourClose = { ...close(), interval: '1h' as const };
    const def = strategy(
      compare(hourClose, 'gt', constant('105')),
      [leg('buy')],
      compare(
        {
          kind: 'position',
          id: 'off',
          field: 'off_peak_pct',
          instrumentId: A,
          interval: '1d',
          adjustment: 'split_and_dividend',
          session: 'regular',
        },
        'gt',
        constant('1'),
      ),
      [leg('sell', { side: 'close' })],
    );
    delete def.exit.trigger;
    const r = simulate({
      definition: def,
      instruments: TEST_INSTRUMENTS,
      inputs: inputs('2024-03-04', '2024-03-08', { interval: '1h' }),
      data: {
        series: new Map([
          [key('1h'), hourly],
          [key('1d'), daily],
        ]),
        dataVersions: ['test@1'],
        warnings: [],
      },
    });
    expect(r.fills.filter((f) => f.side === 'buy')).toHaveLength(1);
    // Before N225 the day-1 close of 100 read as 9% off the 110 entry and sold within the hour.
    expect(r.fills.filter((f) => f.side !== 'buy')).toHaveLength(0);
  });
});
