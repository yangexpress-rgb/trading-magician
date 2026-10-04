import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { Bar } from './bars';
import { atr, bollinger, ema, highest, indicatorSeries, lowest, roc, rsi, sma } from './indicators';

const ds = (...xs: number[]) => xs.map((x) => new Decimal(x));
const nums = (vs: (Decimal | undefined)[]) =>
  vs.map((v) => (v === undefined ? null : v.toNumber()));

function bar(i: number, high: number, low: number, close: number): Bar {
  const start = new Date(Date.UTC(2025, 0, 2 + i)).toISOString();
  return {
    start,
    end: start,
    open: new Decimal(close),
    high: new Decimal(high),
    low: new Decimal(low),
    close: new Decimal(close),
    volume: new Decimal(1000),
  };
}

describe('indicators', () => {
  it('computes hand-checked values', () => {
    expect(nums(sma(ds(1, 2, 3, 4, 5), 3))).toEqual([null, null, 2, 3, 4]);
    expect(nums(ema(ds(1, 2, 3, 4, 5), 3))).toEqual([null, null, 2, 3, 4]);
    expect(nums(rsi(ds(1, 2, 3, 2, 3), 2))).toEqual([null, null, 100, 50, 75]);
    expect(nums(rsi(ds(5, 5, 5), 2))).toEqual([null, null, 50]);
    const bars = [bar(0, 10, 8, 9), bar(1, 11, 9, 10), bar(2, 12, 10, 11), bar(3, 10, 7, 8)];
    expect(nums(atr(bars, 2))).toEqual([null, null, 2, 3]);
    const xs = ds(2, 4, 4, 4, 5, 5, 7, 9);
    expect(bollinger(xs, 8, 2, 'upper')[7]?.toNumber()).toBe(9);
    expect(bollinger(xs, 8, 2, 'middle')[7]?.toNumber()).toBe(5);
    expect(bollinger(xs, 8, 2, 'lower')[7]?.toNumber()).toBe(1);
    expect(nums(highest(ds(3, 1, 4, 1, 5), 3))).toEqual([null, null, 4, 4, 5]);
    expect(nums(lowest(ds(3, 1, 4, 1, 5), 3))).toEqual([null, null, 1, 1, 1]);
    expect(nums(roc(ds(100, 110, 121), 1))).toEqual([null, 10, 10]);
  });

  it('applies catalog defaults and fields', () => {
    const bars = [bar(0, 10, 8, 9), bar(1, 11, 9, 10), bar(2, 12, 10, 11)];
    expect(nums(indicatorSeries('HIGHEST', { period: 2 }, bars, 'high'))).toEqual([null, 11, 12]);
    expect(nums(indicatorSeries('BBANDS', { period: 3, band: 'middle' }, bars, 'close'))).toEqual([
      null,
      null,
      10,
    ]);
    expect(() => indicatorSeries('NOPE', {}, bars, 'close')).toThrow(/Unknown indicator/);
  });

  it('never looks ahead: a value depends only on bars up to its index', () => {
    const series = fc.array(fc.integer({ min: 1, max: 1000 }), { minLength: 2, maxLength: 60 });
    fc.assert(
      fc.property(series, series, fc.integer({ min: 1, max: 20 }), (a, tail, n) => {
        const cut = a.length;
        const base = ds(...a);
        const extended = ds(...a, ...tail);
        for (const f of [sma, ema, rsi, highest, lowest, roc]) {
          expect(nums(f(extended, n).slice(0, cut))).toEqual(nums(f(base, n)));
        }
      }),
      { numRuns: 100 },
    );
  });
});
