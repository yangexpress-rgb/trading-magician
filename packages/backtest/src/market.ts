import {
  barField,
  indicatorSeries,
  type Bar,
  type IndicatorExpr,
  type IndicatorValues,
  type MarketExpr,
  type SeriesResolver,
} from '@tm/domain';
import type Decimal from 'decimal.js';
import { seriesKey } from './data';

type SeriesExpr = MarketExpr | IndicatorExpr;

/** Index of the last bar ending at or before `t`, or -1. Bars are sorted by end. */
function lastEndingBy(bars: readonly Bar[], t: number, from: number): number {
  let i = from;
  for (let next = bars[i + 1]; next && Date.parse(next.end) <= t; next = bars[i + 1]) i++;
  return i;
}

/**
 * Point-in-time view of every series for the condition evaluator. `advance`
 * moves the clock forward; afterwards only bars that have ended are visible,
 * which is what keeps the back test free of lookahead (Design v1.0 §7.2).
 *
 * A series is stale when a bar that other instruments have for the same
 * interval is missing: its latest value is then unknown, so conditions on it
 * cannot qualify, and `is stale` reports true.
 */
export class MarketView implements SeriesResolver {
  private readonly pointers = new Map<string, number>();
  private readonly expectedEnds = new Map<string, number[]>();
  private readonly expectedPointers = new Map<string, number>();
  private readonly indicators = new Map<string, IndicatorValues>();
  private now = Number.NEGATIVE_INFINITY;

  constructor(private readonly series: ReadonlyMap<string, Bar[]>) {
    const ends = new Map<string, Set<number>>();
    for (const [key, bars] of series) {
      const interval = key.split('|')[1] ?? '';
      const set = ends.get(interval) ?? new Set<number>();
      for (const b of bars) set.add(Date.parse(b.end));
      ends.set(interval, set);
    }
    for (const [interval, set] of ends)
      this.expectedEnds.set(
        interval,
        [...set].sort((a, b) => a - b),
      );
  }

  get time(): number {
    return this.now;
  }

  advance(t: number) {
    if (t < this.now) throw new Error('The clock only moves forward');
    this.now = t;
    for (const [key, bars] of this.series) {
      this.pointers.set(key, lastEndingBy(bars, t, this.pointers.get(key) ?? -1));
    }
    for (const [interval, ends] of this.expectedEnds) {
      let i = this.expectedPointers.get(interval) ?? -1;
      for (let next = ends[i + 1]; next !== undefined && next <= t; next = ends[i + 1]) i++;
      this.expectedPointers.set(interval, i);
    }
  }

  /** The latest completed bar of a series, if any. */
  latest(key: string): Bar | undefined {
    const i = this.pointers.get(key) ?? -1;
    return i >= 0 ? this.series.get(key)?.[i] : undefined;
  }

  /** The bar of a series that ends exactly at the current time, if any. */
  barEndingNow(key: string): Bar | undefined {
    const bar = this.latest(key);
    return bar && Date.parse(bar.end) === this.now ? bar : undefined;
  }

  private staleKey(key: string, interval: string): boolean {
    const i = this.pointers.get(key) ?? -1;
    const bar = i >= 0 ? this.series.get(key)?.[i] : undefined;
    const expected = this.expectedEnds.get(interval)?.[this.expectedPointers.get(interval) ?? -1];
    if (expected === undefined) return false;
    return !bar || Date.parse(bar.end) < expected;
  }

  isStale(expr: SeriesExpr): boolean {
    return this.staleKey(seriesKey(expr), expr.interval);
  }

  value(expr: SeriesExpr, barsBack: number): Decimal | undefined {
    const key = seriesKey(expr);
    if (this.staleKey(key, expr.interval)) return undefined;
    const bars = this.series.get(key);
    const at = (this.pointers.get(key) ?? -1) - expr.offset - barsBack;
    if (!bars || at < 0) return undefined;
    if (expr.kind === 'market') {
      const bar = bars[at];
      return bar && barField(bar, expr.field);
    }
    const ikey = `${key}|${expr.name}|${JSON.stringify(expr.params)}|${expr.field}`;
    let values = this.indicators.get(ikey);
    if (!values) {
      values = indicatorSeries(expr.name, expr.params, bars, expr.field);
      this.indicators.set(ikey, values);
    }
    return values[at];
  }
}
