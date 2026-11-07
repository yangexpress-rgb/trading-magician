import {
  barField,
  dailyClose,
  latestObservation,
  nyDate,
  signalAt,
  type OptionPoint,
  type OptionSignal,
  type OptionSignalField,
  type FundamentalField,
  type FundamentalObservation,
  type FundamentalPoint,
  indicatorSeries,
  type Bar,
  type IndicatorExpr,
  type IndicatorValues,
  type MarketExpr,
  type SeriesResolver,
} from '@tm/domain';
import Decimal from 'decimal.js';
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
 *
 * Indicator-only instruments (indices such as the VIX, v1.2 item 5) are
 * joined differently: their latest bar ending at or before the current time
 * is used, so a day the index published nothing reads the most recent close
 * on or before it. Their own bars never make other series look stale.
 */
export class MarketView implements SeriesResolver {
  private readonly pointers = new Map<string, number>();
  private readonly expectedEnds = new Map<string, number[]>();
  private readonly expectedPointers = new Map<string, number>();
  private readonly indicators = new Map<string, IndicatorValues>();
  private now = Number.NEGATIVE_INFINITY;

  private readonly watchOnly: ReadonlySet<string>;

  constructor(
    private readonly series: ReadonlyMap<string, Bar[]>,
    /** Instrument ids of indicator-only instruments. */
    watchOnly: ReadonlySet<string> = new Set(),
    /** Point-in-time company filings by instrument id (v1.2 item 6), sorted by availability. */
    private readonly fundamentals: ReadonlyMap<
      string,
      readonly FundamentalObservation[]
    > = new Map(),
    /** End-of-day options signals by underlying id (options brief v2 §5.3), sorted by as-of date. */
    private readonly options: ReadonlyMap<string, readonly OptionSignal[]> = new Map(),
  ) {
    this.watchOnly = watchOnly;
    const ends = new Map<string, Set<number>>();
    for (const [key, bars] of series) {
      if (this.watchOnly.has(key.split('|')[0] ?? '')) continue;
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
    if (this.watchOnly.has(key.split('|')[0] ?? '')) return false;
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

  /**
   * A company's filing-backed value as the market knew it at the end of the
   * bar `barsBack` daily bars ago (now, for 0): only filings accepted by then
   * count (v1.2 item 6, principle 2).
   */
  fundamental(
    instrumentId: string,
    field: FundamentalField,
    barsBack: number,
  ): FundamentalPoint | undefined {
    const list = this.fundamentals.get(instrumentId);
    if (!list) return undefined;
    let asOf = this.now;
    if (barsBack > 0) {
      const key = seriesKey(dailyClose(instrumentId, 0, 'none'));
      const at = (this.pointers.get(key) ?? -1) - barsBack;
      const bar = at >= 0 ? this.series.get(key)?.[at] : undefined;
      if (!bar) return undefined;
      asOf = Date.parse(bar.end);
    }
    return latestObservation(list, field, asOf);
  }

  /**
   * An underlying's options signal as known at the end of the bar `barsBack`
   * daily bars ago (now, for 0): the latest one whose day had closed by then,
   * no more than 5 trading days old (options data brief v2 §5.3).
   */
  option(
    instrumentId: string,
    field: OptionSignalField,
    barsBack: number,
  ): OptionPoint | undefined {
    const list = this.options.get(instrumentId);
    if (!list) return undefined;
    let asOf = this.now;
    if (barsBack > 0) {
      const key = seriesKey(dailyClose(instrumentId, 0, 'none'));
      const at = (this.pointers.get(key) ?? -1) - barsBack;
      const bar = at >= 0 ? this.series.get(key)?.[at] : undefined;
      if (!bar) return undefined;
      asOf = Date.parse(bar.end);
    }
    const signal = signalAt(list, asOf, (ms) => nyDate(new Date(ms)));
    const value = signal?.values[field];
    if (!signal || value === null || value === undefined) return undefined;
    return { value: new Decimal(value), asOfDate: signal.asOfDate, source: signal.source };
  }

  /** A series' value on its last bar ending at or before `timeMs` (never after now). */
  valueAt(expr: SeriesExpr, timeMs: number): Decimal | undefined {
    if (expr.kind !== 'market') return undefined;
    const bars = this.series.get(seriesKey(expr));
    const last = this.pointers.get(seriesKey(expr)) ?? -1;
    if (!bars || last < 0) return undefined;
    const t = Math.min(timeMs, this.now);
    let lo = 0;
    let hi = last;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (Date.parse((bars[mid] as Bar).end) <= t) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    const bar = found >= 0 ? bars[found] : undefined;
    return bar && barField(bar, expr.field);
  }
}
