import {
  addDays,
  isTradingDay,
  nyDate,
  regularSession,
  UnsupportedBarRequestError,
  type Bar,
  type BarInterval,
  type BarRequest,
  type BarSeries,
  type HistoricalDataProvider,
} from '@tm/domain';
import Decimal from 'decimal.js';
import { mulberry32, normal, seedOf } from './random';

/**
 * Generated price history for the generic DEMO instruments (Design v1.0 §21:
 * demo data only). Prices follow a factor model so pairs within a sector move
 * together, and the series includes a stock split, cash dividends, holidays,
 * early closes and a few missing hourly bars, so back tests meet the same
 * situations real data has.
 *
 * Every value is a pure function of the symbol and date: the same request
 * always returns the same bars, whatever range it asks for.
 */

export const DEMO_HISTORY_VERSION = 'demo-history@1';
export const DEMO_HISTORY_START = '2015-01-02';
const HORIZON = '2035-12-31';
const TRADING_DAYS_PER_YEAR = 252;
const OVERNIGHT_SHARE = 0.2;
/** Fraction of hourly bars left out, to exercise missing-bar handling (§7.2). */
const MISSING_HOURLY_BAR_RATE = 0.003;

type Action =
  | { kind: 'split'; date: string; ratio: number }
  | { kind: 'dividend'; date: string; amount: number };

interface Profile {
  startPrice: number;
  /** Annual drift and volatility of log returns. */
  drift: number;
  vol: number;
  /** Loadings on the market factor and an optional sector factor; the rest is stock-specific. */
  market: number;
  sector?: { name: string; weight: number };
  dailyVolume: number;
  actions: (horizon: string) => Action[];
}

/** First trading day on or after the given day of each listed month, every year. */
function schedule(months: number[], day: number, amount: number) {
  return (horizon: string): Action[] => {
    const out: Action[] = [];
    for (let y = Number(DEMO_HISTORY_START.slice(0, 4)); y <= Number(horizon.slice(0, 4)); y++) {
      for (const m of months) {
        let date = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        while (!isTradingDay(date)) date = addDays(date, 1);
        if (date > DEMO_HISTORY_START && date <= horizon)
          out.push({ kind: 'dividend', date, amount });
      }
    }
    return out;
  };
}

const none = () => [];

export const DEMO_PROFILES: Readonly<Record<string, Profile>> = {
  'DEMO-A': {
    startPrice: 48,
    drift: 0.07,
    vol: 0.22,
    market: 0.5,
    sector: { name: 'beverages', weight: 0.75 },
    dailyVolume: 2_000_000,
    actions: none,
  },
  'DEMO-B': {
    startPrice: 52,
    drift: 0.06,
    vol: 0.24,
    market: 0.5,
    sector: { name: 'beverages', weight: 0.75 },
    dailyVolume: 1_500_000,
    actions: none,
  },
  'DEMO-C': {
    startPrice: 140,
    drift: 0.12,
    vol: 0.35,
    market: 0.55,
    sector: { name: 'software', weight: 0.6 },
    dailyVolume: 3_000_000,
    actions: () => [{ kind: 'split', date: '2021-06-14', ratio: 2 }],
  },
  'DEMO-D': {
    startPrice: 85,
    drift: 0.1,
    vol: 0.38,
    market: 0.55,
    sector: { name: 'software', weight: 0.6 },
    dailyVolume: 2_500_000,
    actions: none,
  },
  'DEMO-E': {
    startPrice: 60,
    drift: 0.03,
    vol: 0.3,
    market: 0.45,
    sector: { name: 'energy', weight: 0.7 },
    dailyVolume: 1_200_000,
    actions: schedule([2, 5, 8, 11], 15, 0.5),
  },
  'DEMO-IDX': {
    startPrice: 400,
    drift: 0.08,
    vol: 0.16,
    market: 0.97,
    dailyVolume: 50_000_000,
    actions: schedule([3, 6, 9, 12], 20, 1.4),
  },
  'DEMO-BND': {
    startPrice: 100,
    drift: 0.01,
    vol: 0.06,
    market: -0.1,
    sector: { name: 'rates', weight: 0.8 },
    dailyVolume: 5_000_000,
    actions: schedule([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 1, 0.25),
  },
};

interface Segment {
  start: string;
  end: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  missing: boolean;
}

interface Day {
  date: string;
  segments: Segment[];
}

/** Volume share of each intraday bar: heavier at the open and the close. */
const VOLUME_SHAPE = [0.2, 0.13, 0.11, 0.1, 0.11, 0.15, 0.2];
const EARLY_SHAPE = [0.35, 0.25, 0.2, 0.2];
const DRAWS_PER_DAY = 1 + VOLUME_SHAPE.length;

const cents = (x: number) => Math.round(x * 100) / 100;

/** Normal draws for one factor on one date: overnight gap, then one per intraday bar. */
function shocks(key: string, date: string, count: number): number[] {
  const draw = normal(mulberry32(seedOf(`${key}|${date}`)));
  return Array.from({ length: count }, draw);
}

/** Hourly bar boundaries of a regular session, the last one possibly shorter. */
function segmentBounds(open: string, close: string): [string, string][] {
  const out: [string, string][] = [];
  const end = Date.parse(close);
  for (let t = Date.parse(open); t < end; t += 3_600_000) {
    out.push([new Date(t).toISOString(), new Date(Math.min(t + 3_600_000, end)).toISOString()]);
  }
  return out;
}

class SymbolHistory {
  readonly days: Day[] = [];
  readonly actions: Action[];
  private level: number;
  private splitFactor = 1;
  private cursor = DEMO_HISTORY_START;

  constructor(
    readonly symbol: string,
    private readonly profile: Profile,
  ) {
    this.level = profile.startPrice;
    this.actions = profile.actions(HORIZON);
  }

  /** Generates trading days up to and including `to`. */
  ensure(to: string) {
    const target = to > HORIZON ? HORIZON : to;
    const p = this.profile;
    const wSector = p.sector?.weight ?? 0;
    const wIdio = Math.sqrt(Math.max(0, 1 - p.market ** 2 - wSector ** 2));
    const dailyVar = p.vol ** 2 / TRADING_DAYS_PER_YEAR;
    const dailyDrift = p.drift / TRADING_DAYS_PER_YEAR;

    for (; this.cursor <= target; this.cursor = addDays(this.cursor, 1)) {
      const date = this.cursor;
      const session = regularSession(date);
      if (!session) continue;
      for (const a of this.actions) {
        if (a.date !== date) continue;
        if (a.kind === 'split') {
          this.level /= a.ratio;
          this.splitFactor *= a.ratio;
        } else {
          this.level = Math.max(this.level - a.amount, this.level * 0.5);
        }
      }

      const m = shocks('market', date, DRAWS_PER_DAY);
      const s = p.sector ? shocks(`sector:${p.sector.name}`, date, DRAWS_PER_DAY) : [];
      const e = shocks(`symbol:${this.symbol}`, date, DRAWS_PER_DAY * 3);
      const z = (i: number) => p.market * (m[i] ?? 0) + wSector * (s[i] ?? 0) + wIdio * (e[i] ?? 0);

      const bounds = segmentBounds(session.open, session.close);
      const minutes = bounds.map(([a, b]) => (Date.parse(b) - Date.parse(a)) / 60_000);
      const total = minutes.reduce((a, b) => a + b, 0);
      const shape = bounds.length === VOLUME_SHAPE.length ? VOLUME_SHAPE : EARLY_SHAPE;

      // Overnight gap into the first bar's open.
      const gapVar = dailyVar * OVERNIGHT_SHARE;
      let price = cents(
        this.level * Math.exp(dailyDrift * OVERNIGHT_SHARE - gapVar / 2 + Math.sqrt(gapVar) * z(0)),
      );
      const segments: Segment[] = bounds.map(([start, end], i) => {
        const share = ((minutes[i] ?? 0) / total) * (1 - OVERNIGHT_SHARE);
        const v = dailyVar * share;
        const open = price;
        const close = cents(open * Math.exp(dailyDrift * share - v / 2 + Math.sqrt(v) * z(i + 1)));
        const wick = Math.sqrt(v) * 0.6;
        const high = Math.max(
          open,
          close,
          cents(Math.max(open, close) * (1 + Math.abs(e[DRAWS_PER_DAY + i] ?? 0) * wick)),
        );
        const low = Math.min(
          open,
          close,
          cents(Math.min(open, close) * (1 - Math.abs(e[2 * DRAWS_PER_DAY + i] ?? 0) * wick)),
        );
        const noise = Math.exp(0.3 * (e[2 * DRAWS_PER_DAY + 7] ?? 0));
        const volume = Math.round(p.dailyVolume * (shape[i] ?? 0.1) * noise * this.splitFactor);
        const missingDraw = mulberry32(seedOf(`missing|${this.symbol}|${start}`))();
        price = close;
        return {
          start,
          end,
          open,
          high,
          low,
          close,
          volume,
          missing: i > 0 && missingDraw < MISSING_HOURLY_BAR_RATE,
        };
      });
      this.level = price;
      this.days.push({ date, segments });
    }
  }
}

const histories = new Map<string, SymbolHistory>();

function historyFor(symbol: string): SymbolHistory {
  const profile = DEMO_PROFILES[symbol];
  if (!profile) throw new UnsupportedBarRequestError(`No demo history for ${symbol}`);
  let h = histories.get(symbol);
  if (!h) histories.set(symbol, (h = new SymbolHistory(symbol, profile)));
  return h;
}

interface Factors {
  price: number;
  volume: number;
}

/**
 * Backward adjustment factors per date: splits scale earlier prices down and
 * volumes up; dividends scale earlier prices by (1 − dividend / prior close).
 */
function adjustmentFactors(
  h: SymbolHistory,
  adjustment: BarRequest['adjustment'],
  asOf: string,
): (date: string) => Factors {
  if (adjustment === 'none') return () => ({ price: 1, volume: 1 });
  const closeBefore = (date: string) => {
    const i = h.days.findIndex((d) => d.date >= date);
    return h.days[i - 1]?.segments.at(-1)?.close;
  };
  const steps = h.actions
    .filter((a) => a.date <= asOf)
    .filter((a) => a.kind === 'split' || adjustment === 'split_and_dividend')
    .map((a) => {
      if (a.kind === 'split') return { date: a.date, price: 1 / a.ratio, volume: a.ratio };
      const prior = closeBefore(a.date);
      return { date: a.date, price: prior ? 1 - a.amount / prior : 1, volume: 1 };
    });
  return (date) => {
    let price = 1;
    let volume = 1;
    for (const s of steps) {
      if (s.date > date) {
        price *= s.price;
        volume *= s.volume;
      }
    }
    return { price, volume };
  };
}

function toBar(
  s: Pick<Segment, 'start' | 'end' | 'open' | 'high' | 'low' | 'close' | 'volume'>,
  f: Factors,
  places: number,
): Bar {
  const px = (x: number) => new Decimal(x).times(f.price).toDecimalPlaces(places);
  return {
    start: s.start,
    end: s.end,
    open: px(s.open),
    high: px(s.high),
    low: px(s.low),
    close: px(s.close),
    volume: new Decimal(Math.round(s.volume * f.volume)),
  };
}

const SUPPORTED: readonly BarInterval[] = ['5m', '1h', '1d'];

const FIVE_MIN = 5 * 60_000;

/**
 * Five-minute bars inside an hourly segment (ADR 0029), seeded from the symbol
 * and the segment's start so they never change. A Brownian bridge runs from
 * the segment's open to its close; the segment's high and low are each
 * reached by one bar, and its volume is shared out among the bars. So the
 * five-minute bars always add up to the hourly bar they came from.
 */
export function fiveMinuteSegments(symbol: string, s: Segment | DemoSegment): DemoSegment[] {
  const t0 = Date.parse(s.start);
  const n = Math.max(1, Math.round((Date.parse(s.end) - t0) / FIVE_MIN));
  const uniform = mulberry32(seedOf(`5m|${symbol}|${s.start}`));
  const z = normal(uniform);
  const walk = [0];
  for (let k = 1; k <= n; k++) walk.push((walk[k - 1] ?? 0) + z());
  const last = walk[n] ?? 0;
  const scale = (s.high - s.low) / (2 * Math.sqrt(n) || 1);
  const points = walk.map((w, k) => {
    const bridge = w - (k / n) * last;
    const p = s.open + ((s.close - s.open) * k) / n + bridge * scale;
    return k === 0 ? s.open : k === n ? s.close : cents(Math.min(s.high, Math.max(s.low, p)));
  });
  const weights = Array.from({ length: n }, () => 0.5 + uniform());
  const sum = weights.reduce((a, w) => a + w, 0);
  let left = s.volume;
  const bars = Array.from({ length: n }, (_, j) => {
    const open = points[j] ?? s.open;
    const close = points[j + 1] ?? s.close;
    const wick = (s.high - s.low) * 0.15;
    const volume = j === n - 1 ? left : Math.round((s.volume * (weights[j] ?? 1)) / sum);
    left -= volume;
    return {
      start: new Date(t0 + j * FIVE_MIN).toISOString(),
      end: new Date(Math.min(t0 + (j + 1) * FIVE_MIN, Date.parse(s.end))).toISOString(),
      open,
      high: Math.min(s.high, cents(Math.max(open, close) + uniform() * wick)),
      low: Math.max(s.low, cents(Math.min(open, close) - uniform() * wick)),
      close,
      volume: Math.max(0, volume),
    };
  });
  // The segment's extremes happen somewhere inside it.
  const top = bars.reduce((b, x, i) => (x.high > (bars[b]?.high ?? -Infinity) ? i : b), 0);
  const bottom = bars.reduce((b, x, i) => (x.low < (bars[b]?.low ?? Infinity) ? i : b), 0);
  const topBar = bars[top];
  const bottomBar = bars[bottom];
  if (topBar) topBar.high = s.high;
  if (bottomBar) bottomBar.low = s.low;
  return bars;
}

export interface DemoHistoryOptions {
  /** Bars ending after this instant are never returned. Defaults to the current time. */
  now?: () => Date;
}

/** Historical-data provider over the generated demo history. */
export function createDemoHistoryProvider(
  options: DemoHistoryOptions = {},
): HistoricalDataProvider {
  const now = options.now ?? (() => new Date());
  return {
    id: 'demo',
    intervals: SUPPORTED,
    async getBars(req: BarRequest): Promise<BarSeries> {
      if (!SUPPORTED.includes(req.interval)) {
        throw new UnsupportedBarRequestError(
          `Demo history has daily, hourly and 5-minute bars, not ${req.interval}`,
        );
      }
      if (req.from > req.to)
        throw new UnsupportedBarRequestError('The start date is after the end date');
      const h = historyFor(req.symbol);
      const warnings: string[] = [];
      const cutoff = now();
      const lastDate = nyDate(cutoff);
      const to = req.to > lastDate ? lastDate : req.to;
      let from = req.from;
      if (from < DEMO_HISTORY_START) {
        warnings.push(`Demo history starts on ${DEMO_HISTORY_START}`);
        from = DEMO_HISTORY_START;
      }
      if (req.session === 'extended') {
        warnings.push('Demo history has regular-session bars only');
      }
      // Adjusted prices are as of today, like a real feed's, so the version names that date.
      h.ensure(lastDate);
      const factors = adjustmentFactors(h, req.adjustment, lastDate);
      const places = req.adjustment === 'none' ? 2 : 4;
      const bars: Bar[] = [];
      for (const day of h.days) {
        if (day.date < from) continue;
        if (day.date > to) break;
        const f = factors(day.date);
        if (req.interval === '1d') {
          const first = day.segments[0];
          const last = day.segments.at(-1);
          if (!first || !last) continue;
          bars.push(
            toBar(
              {
                start: first.start,
                end: last.end,
                open: first.open,
                high: Math.max(...day.segments.map((s) => s.high)),
                low: Math.min(...day.segments.map((s) => s.low)),
                close: last.close,
                volume: day.segments.reduce((a, s) => a + s.volume, 0),
              },
              f,
              places,
            ),
          );
        } else if (req.interval === '5m') {
          for (const s of day.segments) {
            if (s.missing) continue;
            for (const b of fiveMinuteSegments(req.symbol, s)) bars.push(toBar(b, f, places));
          }
        } else {
          for (const s of day.segments) if (!s.missing) bars.push(toBar(s, f, places));
        }
      }
      const complete = bars.filter((b) => Date.parse(b.end) <= cutoff.getTime());
      const dataVersion =
        req.adjustment === 'none'
          ? DEMO_HISTORY_VERSION
          : `${DEMO_HISTORY_VERSION}+adjusted-${lastDate}`;
      return { bars: complete, dataVersion, warnings };
    },
  };
}

/** An hourly segment of the generated history, unadjusted, including bars hidden as missing. */
export interface DemoSegment {
  start: string;
  end: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * The raw segment in progress at `at`, or, outside the regular session, the
 * last segment that ended before it. The live demo feed reads prices from
 * these, so live quotes and historical bars always agree.
 */
export function demoSegmentAt(
  symbol: string,
  at: Date,
): { segment: DemoSegment; inSession: boolean } | undefined {
  const h = historyFor(symbol);
  const date = nyDate(at);
  h.ensure(date);
  const t = at.getTime();
  for (let i = h.days.length - 1; i >= 0; i--) {
    const day = h.days[i];
    if (!day || day.date > date) continue;
    for (let j = day.segments.length - 1; j >= 0; j--) {
      const s = day.segments[j];
      if (!s || Date.parse(s.start) > t) continue;
      return { segment: s, inSession: t < Date.parse(s.end) };
    }
  }
  return undefined;
}
