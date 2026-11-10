import { describe, expect, it } from 'vitest';
import {
  alignBars,
  axisScaleFor,
  brokenPath,
  formatPercent,
  lastIndexAtOrBefore,
  mergeBars,
  panView,
  percentFromFirst,
  viewIndexes,
  zoomView,
} from './chart-history';
import type { Bar } from './research-text';

const bar = (t: number, close = 100): Bar => ({
  t,
  open: close,
  high: close,
  low: close,
  close,
  volume: 1,
});
const series = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => bar(from + i, 100 + from + i));

describe('moving through time (N195)', () => {
  it('merges older and newer stretches into one series, oldest first, without repeats', () => {
    const merged = mergeBars(series(10, 20), series(0, 12));
    expect(merged.map((b) => b.t)).toEqual(Array.from({ length: 21 }, (_, i) => i));
  });

  it('finds the last bar at or before a time', () => {
    const bars = [bar(10), bar(20), bar(30)];
    expect(lastIndexAtOrBefore(bars, 5)).toBe(-1);
    expect(lastIndexAtOrBefore(bars, 20)).toBe(1);
    expect(lastIndexAtOrBefore(bars, 29)).toBe(1);
    expect(lastIndexAtOrBefore(bars, 99)).toBe(2);
  });

  it('keeps the view on the same bars when older ones are added in front', () => {
    const view = { right: 20, count: 5 };
    const before = series(10, 20);
    const after = mergeBars(series(0, 9), before);
    const a = viewIndexes(before, view);
    const b = viewIndexes(after, view);
    expect(before[a.first]!.t).toBe(16);
    expect(after[b.first]!.t).toBe(16);
    expect(after[b.last]!.t).toBe(20);
  });

  it('pans by whole bars and stops at either end', () => {
    const bars = series(0, 99);
    const view = { right: 99, count: 10 };
    expect(panView(bars, view, -15).right).toBe(84);
    expect(panView(bars, view, 5).right).toBe(99);
    // Never past the oldest bar: the view stays full.
    expect(panView(bars, view, -500).right).toBe(9);
  });

  it('zooms around the right edge within sensible limits', () => {
    const bars = series(0, 99);
    const view = { right: 50, count: 20 };
    expect(zoomView(bars, view, 2)).toEqual({ right: 50, count: 40 });
    expect(zoomView(bars, view, 0.1)).toEqual({ right: 50, count: 10 });
    expect(zoomView(bars, view, 100).count).toBe(100);
  });
});

describe('comparing symbols (N196)', () => {
  it('lines up another symbol by bar time, with gaps where it has none', () => {
    const main = [bar(1), bar(2), bar(3)];
    const other = [bar(1, 50), bar(3, 55)];
    expect(alignBars(main, other).map((b) => b?.close ?? null)).toEqual([50, null, 55]);
  });

  it('measures each line from its first close in view', () => {
    const { base, pct } = percentFromFirst([null, bar(1, 50), bar(2, 55), null, bar(3, 45)]);
    expect(base).toBe(50);
    expect(pct.map((p) => (p === null ? null : Math.round(p * 100) / 100))).toEqual([
      null,
      0,
      10,
      null,
      -10,
    ]);
    expect(formatPercent(10)).toBe('+10%');
    expect(formatPercent(-1.234)).toBe('−1.23%');
    expect(formatPercent(0)).toBe('0%');
  });

  it('draws a broken line across gaps', () => {
    expect(brokenPath([[0, 1], [1, 2], null, [3, 4]])).toBe('M0.0,1.0L1.0,2.0M3.0,4.0');
  });

  it('labels the axis for the span in view', () => {
    expect(axisScaleFor(0, 1, true)).toBe('1d');
    expect(axisScaleFor(0, 30 * 86_400_000, false)).toBe('1m');
    expect(axisScaleFor(0, 400 * 86_400_000, false)).toBe('1y');
  });
});
