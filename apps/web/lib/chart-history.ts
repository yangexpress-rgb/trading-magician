import type { ChartRange } from '@tm/domain';
import type { Bar } from './research-text';

/**
 * Chart arithmetic for moving through time and comparing symbols on the
 * Price charts page (N194–N196). Pure, so it is tested without a browser.
 */

/** At most four symbols beside the main one, one per remaining colour slot (N196). */
export const MAX_COMPARE = 4;

/** Bars of both lists, oldest first, one per start time; `b` wins a tie. */
export function mergeBars(a: readonly Bar[], b: readonly Bar[]): Bar[] {
  const byTime = new Map<number, Bar>();
  for (const bar of a) byTime.set(bar.t, bar);
  for (const bar of b) byTime.set(bar.t, bar);
  return [...byTime.values()].sort((x, y) => x.t - y.t);
}

/** Index of the last bar that starts at or before `t`; -1 when none does. */
export function lastIndexAtOrBefore(bars: readonly Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if ((bars[mid] as Bar).t <= t) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/**
 * The part of the series in view: `count` bars ending at the bar that starts
 * at `right` (or just before it). Anchoring on a time, not an index, keeps the
 * view still while older bars are added in front.
 */
export interface ChartView {
  /** Start time of the rightmost bar in view. */
  right: number;
  /** How many bars are in view: the zoom. */
  count: number;
}

export const MIN_VIEW_BARS = 10;
export const MAX_VIEW_BARS = 2000;

export function viewIndexes(
  bars: readonly Bar[],
  view: ChartView,
): { first: number; last: number } {
  if (bars.length === 0) return { first: 0, last: -1 };
  const count = Math.max(1, Math.min(bars.length, view.count));
  let last = lastIndexAtOrBefore(bars, view.right);
  // Never leave empty space on the left while there are bars to fill it.
  last = Math.max(count - 1, Math.min(bars.length - 1, last));
  return { first: last - count + 1, last };
}

/** The view moved by `delta` bars: negative goes back in time. */
export function panView(bars: readonly Bar[], view: ChartView, delta: number): ChartView {
  const { last } = viewIndexes(bars, view);
  const count = Math.min(view.count, bars.length);
  const next = Math.max(count - 1, Math.min(bars.length - 1, last + Math.round(delta)));
  const bar = bars[next];
  return bar ? { ...view, right: bar.t } : view;
}

/**
 * How many bars of a pan back in time did not fit because older bars are
 * not loaded yet (N195): negative, or 0 when the whole pan fitted.
 */
export function panShortfall(bars: readonly Bar[], view: ChartView, delta: number): number {
  if (delta >= 0) return 0;
  const { first } = viewIndexes(bars, view);
  return Math.min(0, first + Math.round(delta));
}

/** The view with more (factor > 1) or fewer bars, its right edge kept. */
export function zoomView(bars: readonly Bar[], view: ChartView, factor: number): ChartView {
  const most = Math.min(MAX_VIEW_BARS, Math.max(MIN_VIEW_BARS, bars.length));
  const count = Math.round(
    Math.max(Math.min(MIN_VIEW_BARS, bars.length), Math.min(most, view.count * factor)),
  );
  const { last } = viewIndexes(bars, view);
  const bar = bars[last];
  return { right: bar ? bar.t : view.right, count };
}

/**
 * Another symbol's bars lined up with the main symbol's, by start time; a
 * slot is null where that symbol has no bar (N196).
 */
export function alignBars(main: readonly Bar[], other: readonly Bar[]): (Bar | null)[] {
  const byTime = new Map(other.map((b) => [b.t, b]));
  return main.map((b) => byTime.get(b.t) ?? null);
}

/**
 * Percent change of each bar's close from the first close in view, as
 * TradingView's compare does (N196): every line starts at 0% on the left edge.
 */
export function percentFromFirst(bars: readonly (Bar | null)[]): {
  base: number | null;
  pct: (number | null)[];
} {
  const base = bars.find((b) => b && b.close > 0)?.close ?? null;
  return {
    base,
    pct: bars.map((b) => (b && base ? (b.close / base - 1) * 100 : null)),
  };
}

/** `+4.2%`, `−1.05%`, `0%`. */
export function formatPercent(value: number, digits = 2): string {
  const sign = value > 0 ? '+' : value < 0 ? '−' : '';
  return `${sign}${Math.abs(value).toLocaleString('en-US', { maximumFractionDigits: digits })}%`;
}

/**
 * The axis labels that fit the bars in view, whatever range opened the chart:
 * times within one day, days within a few months, months beyond.
 */
export function axisScaleFor(first: number, last: number, sameDay: boolean): ChartRange {
  if (sameDay) return '1d';
  return last - first > 200 * 86_400_000 ? '1y' : '1m';
}

/** An SVG path through the points, broken where a value is missing. */
export function brokenPath(points: readonly (readonly [number, number] | null)[]): string {
  let d = '';
  let pen = false;
  for (const p of points) {
    if (!p) {
      pen = false;
      continue;
    }
    d += `${pen ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`;
    pen = true;
  }
  return d;
}
