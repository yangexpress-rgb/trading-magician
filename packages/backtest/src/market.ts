import {
  barField,
  eventPointAt,
  type EventData,
  type EventMetricId,
  type EventPoint,
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
  type MlPoint,
  type MlPredictionData,
  predictionAt,
  sessionBarsAt,
  type SessionBars,
  type SeriesResolver,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { seriesKey } from './data';

type SeriesExpr = MarketExpr | IndicatorExpr;

/** Intraday bar sizes session values can read (N253); daily and weekly bars can't. */
const SESSION_INTERVAL_MINUTES: Record<string, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
};

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
  /** The intraday series each instrument's session values read (N253), chosen once. */
  private readonly sessionKeys = new Map<string, string | undefined>();
  private readonly sessionCache = new Map<string, { at: number; bars: SessionBars | undefined }>();

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
    /** Earnings, deals and rates (free data feeds brief v1 §6), when the strategy reads any. */
    private readonly events: EventData | undefined = undefined,
    /** Stored model scores by model key, then instrument id (ML brief v1 §8), sorted by date. */
    private readonly mlScores: MlPredictionData = new Map(),
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

  /**
   * An earnings, deal or rate metric as known at the end of the bar
   * `barsBack` daily bars ago (now, for 0): the latest record on or before
   * it (free data feeds brief v1 §6). The deal spread reads that bar's
   * unadjusted close, as the offer price is in dollars of the day.
   */
  event(instrumentId: string, metric: EventMetricId, barsBack: number): EventPoint | undefined {
    if (!this.events) return undefined;
    const key = seriesKey(dailyClose(instrumentId, 0, 'none'));
    const at = (this.pointers.get(key) ?? -1) - barsBack;
    const bar = at >= 0 ? this.series.get(key)?.[at] : undefined;
    if (barsBack > 0 && !bar) return undefined;
    const asOf = barsBack > 0 && bar ? Date.parse(bar.end) : this.now;
    const close = bar ? Number(bar.close) : undefined;
    return eventPointAt(this.events, instrumentId, metric, asOf, close);
  }

  /**
   * A model series' stored score as known at the end of the bar `barsBack`
   * daily bars ago (now, for 0): the latest prediction whose date had closed
   * by then, no more than 45 calendar days old (ML brief v1 §8). A bar further
   * back is dated by the instrument's own daily closes; without them it is unknown.
   */
  ml(instrumentId: string, modelKey: string, barsBack: number): MlPoint | undefined {
    const list = this.mlScores.get(modelKey)?.get(instrumentId);
    if (!list) return undefined;
    let asOf = this.now;
    if (barsBack > 0) {
      let bar: Bar | undefined;
      for (const adjustment of ['none', 'split_and_dividend', 'split_only'] as const) {
        const key = seriesKey(dailyClose(instrumentId, 0, adjustment));
        const at = (this.pointers.get(key) ?? -1) - barsBack;
        bar = at >= 0 ? this.series.get(key)?.[at] : undefined;
        if (bar) break;
      }
      if (!bar) return undefined;
      asOf = Date.parse(bar.end);
    }
    const prediction = predictionAt(list, asOf);
    if (!prediction || !Number.isFinite(prediction.score)) return undefined;
    return { value: new Decimal(prediction.score), modelKey, prediction };
  }

  /**
   * Today's completed regular-session bars of an instrument, as of the bar
   * `barsBack` bars before the current one (intraday pack brief §2, N253).
   * They come from its finest loaded intraday series: the one the run steps
   * on, or a finer one its rules read. Only bars that have ended count, so the
   * values never see a later bar; a stale series reads unknown, as `value` does.
   */
  session(instrumentId: string, barsBack: number): SessionBars | undefined {
    const key = this.sessionKey(instrumentId);
    if (!key) return undefined;
    if (this.staleKey(key, key.split('|')[1] ?? '')) return undefined;
    const bars = this.series.get(key);
    const at = (this.pointers.get(key) ?? -1) - barsBack;
    if (!bars || at < 0) return undefined;
    const cacheKey = `${key}|${barsBack}`;
    const hit = this.sessionCache.get(cacheKey);
    if (hit && hit.at === at) return hit.bars;
    const out = sessionBarsAt(bars, at);
    this.sessionCache.set(cacheKey, { at, bars: out });
    return out;
  }

  private sessionKey(instrumentId: string): string | undefined {
    if (this.sessionKeys.has(instrumentId)) return this.sessionKeys.get(instrumentId);
    const rank = (key: string) => {
      const [, interval = '', adjustment, session] = key.split('|');
      // Finest bars first; then the run's own price basis, regular session.
      return (
        (SESSION_INTERVAL_MINUTES[interval] ?? Infinity) * 100 +
        (adjustment === 'split_and_dividend' ? 0 : 10) +
        (session === 'regular' ? 0 : 1)
      );
    };
    let best: string | undefined;
    for (const key of this.series.keys()) {
      if (!key.startsWith(`${instrumentId}|`)) continue;
      if (SESSION_INTERVAL_MINUTES[key.split('|')[1] ?? ''] === undefined) continue;
      if (!best || rank(key) < rank(best)) best = key;
    }
    this.sessionKeys.set(instrumentId, best);
    return best;
  }

  /** When the bar `value` reads ended (N224); undefined when there is none. */
  barEnd(expr: SeriesExpr, barsBack: number): number | undefined {
    const key = seriesKey(expr);
    const at = (this.pointers.get(key) ?? -1) - expr.offset - barsBack;
    const bar = at >= 0 ? this.series.get(key)?.[at] : undefined;
    return bar ? Date.parse(bar.end) : undefined;
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
