import Decimal from 'decimal.js';
import type { Bar } from '../market/bars';
import { regularSession } from '../market/calendar';
import {
  FUNDAMENTAL_MAX_AGE_DAYS,
  type FundamentalField,
  type FundamentalObservation,
  type FundamentalPoint,
} from '../market/point-in-time';
import {
  computeMetric,
  dailyClose,
  type DailySeries,
  type MetricReader,
} from '../strategy/metrics';
import { metricRequirements } from '../strategy/metrics';
import type { MetricRef } from '../strategy/schema';

/**
 * The factor catalogue v1 of pattern discovery (pattern brief §4, N261,
 * ADR 0091). A factor is one point-in-time number for one instrument on one
 * date, worked out as of that date's close from the app's own point-in-time
 * machinery: the registry metrics a strategy condition reads, filings as
 * filed by then, the events store and the recorded options signals. Unknown
 * is null (left out of the stored values), never 0 and never estimated.
 *
 * Each factor says which atom modes it offers (§4): cross-sectional quintiles
 * across the universe that date, or percentiles of its own trailing 252 known
 * values. The miner forms the atoms at scan time; the snapshot stores raw values.
 */

export const FACTOR_CATALOGUE_VERSION = 1;

export const FACTOR_CATEGORIES = [
  'price',
  'fundamentals',
  'earnings',
  'options',
  'session',
] as const;
export type FactorCategory = (typeof FACTOR_CATEGORIES)[number];

export const FACTOR_CATEGORY_LABELS: Record<FactorCategory, string> = {
  price: 'Price and volume (daily)',
  fundamentals: 'Fundamentals (point in time)',
  earnings: 'Earnings and events',
  options: 'Options signals',
  session: 'Session (intraday)',
};

/** Cross-sectional quintiles across the universe that day, or the instrument's own trailing percentiles. */
export type AtomMode = 'cross' | 'own';

export interface FactorSpec {
  id: string;
  category: FactorCategory;
  label: string;
  /** One line for the coverage report and the pattern page. */
  definition: string;
  modes: readonly AtomMode[];
  /** The registry metric it reads, when it is one; otherwise computed here. */
  metric?: MetricRef;
  /** Instruments it is worked out for: every snapshot member, or the options universe only (§4). */
  scope: 'all' | 'options_universe';
}

const CROSS: readonly AtomMode[] = ['cross'];
const OWN: readonly AtomMode[] = ['own'];
const BOTH: readonly AtomMode[] = ['cross', 'own'];

const ret = (months: string): MetricRef => ({
  metric: 'return',
  params: { lookbackMonths: months, skipMonths: '0' },
});
const plainMetric = (metric: string): MetricRef => ({ metric, params: {} });

export const FACTOR_CATALOGUE_V1: readonly FactorSpec[] = [
  // Price and volume, daily adjusted bars.
  {
    id: 'return_5d',
    category: 'price',
    label: '5-day return',
    definition: 'Close ÷ close 5 trading days earlier − 1 (adjusted)',
    modes: CROSS,
    scope: 'all',
  },
  {
    id: 'return_21d',
    category: 'price',
    label: '1-month return',
    definition: 'Registry Return, 1 month (21 trading days)',
    modes: CROSS,
    metric: ret('1'),
    scope: 'all',
  },
  {
    id: 'return_63d',
    category: 'price',
    label: '3-month return',
    definition: 'Registry Return, 3 months (63 trading days)',
    modes: CROSS,
    metric: ret('3'),
    scope: 'all',
  },
  {
    id: 'return_126d',
    category: 'price',
    label: '6-month return',
    definition: 'Registry Return, 6 months (126 trading days)',
    modes: CROSS,
    metric: ret('6'),
    scope: 'all',
  },
  {
    id: 'return_252d',
    category: 'price',
    label: '12-month return',
    definition: 'Registry Return, 12 months (252 trading days)',
    modes: CROSS,
    metric: ret('12'),
    scope: 'all',
  },
  {
    id: 'rsi_14',
    category: 'price',
    label: 'RSI(14)',
    definition: 'Registry RSI, 14 daily bars',
    modes: CROSS,
    metric: { metric: 'rsi', params: { period: 14, interval: '1d' } },
    scope: 'all',
  },
  {
    id: 'volatility_60',
    category: 'price',
    label: '60-day volatility',
    definition: 'Registry Volatility: annualised SD of daily returns, 60 bars',
    modes: BOTH,
    metric: { metric: 'volatility', params: { window: 60 } },
    scope: 'all',
  },
  {
    id: 'dist_52w_high',
    category: 'price',
    label: 'Distance to 52-week high',
    definition: 'Close ÷ highest adjusted close of the last 252 trading days − 1',
    modes: CROSS,
    scope: 'all',
  },
  {
    id: 'volume_ratio_60',
    category: 'price',
    label: 'Volume vs 60-day average',
    definition: "Today's volume ÷ the average volume of the 60 trading days before",
    modes: BOTH,
    scope: 'all',
  },
  {
    id: 'ma_distance_50',
    category: 'price',
    label: 'Distance to 50-day average',
    definition: 'Registry Moving-average distance, SMA 50',
    modes: CROSS,
    metric: { metric: 'ma_distance', params: { period: 50 } },
    scope: 'all',
  },
  {
    id: 'ma_distance_200',
    category: 'price',
    label: 'Distance to 200-day average',
    definition: 'Registry Moving-average distance, SMA 200',
    modes: CROSS,
    metric: { metric: 'ma_distance', params: { period: 200 } },
    scope: 'all',
  },
  // Fundamentals, as filed by that date (EDGAR replay).
  ...(
    [
      ['revenue_ttm', 'Revenue (TTM)', 'revenue_ttm'],
      ['ebitda_ttm', 'EBITDA (TTM)', undefined],
      ['eps_ttm', 'EPS (TTM)', 'eps_ttm'],
      ['net_income_ttm', 'Net income (TTM)', 'net_income_ttm'],
      ['cash', 'Cash', undefined],
      ['debt', 'Debt', undefined],
      ['equity', "Shareholders' equity", undefined],
      ['earnings_yield', 'Earnings yield', 'earnings_yield'],
      ['ev_ebitda', 'EV/EBITDA', 'ev_ebitda'],
      ['price_to_book', 'Price-to-book', 'price_to_book'],
      ['dividend_yield', 'Dividend yield', 'dividend_yield'],
      ['dividend_streak', 'Dividend-growth streak', 'dividend_streak'],
    ] as const
  ).map(([id, label, metric]): FactorSpec => ({
    id,
    category: 'fundamentals',
    label,
    definition: metric
      ? `Registry ${label}, as filed by that date`
      : `Latest filed ${label.toLowerCase()}, as filed by that date`,
    modes: CROSS,
    ...(metric ? { metric: plainMetric(metric) } : {}),
    scope: 'all',
  })),
  {
    id: 'revenue_growth_yoy',
    category: 'fundamentals',
    label: 'Revenue growth (TTM, YoY)',
    definition:
      'Revenue (TTM) ÷ revenue (TTM) four quarters earlier − 1, both as filed by that date',
    modes: CROSS,
    scope: 'all',
  },
  {
    id: 'fcf_margin',
    category: 'fundamentals',
    label: 'Free-cash-flow margin',
    definition:
      '(Operating cash flow − capital expenditure) ÷ revenue, trailing twelve months, as filed by that date',
    modes: CROSS,
    scope: 'all',
  },
  // Earnings and events (events store).
  {
    id: 'earnings.sue_ts',
    category: 'earnings',
    label: 'Earnings surprise (SUE)',
    definition: 'Registry earnings.sue_ts: time-series SUE of the latest release',
    modes: CROSS,
    metric: plainMetric('earnings.sue_ts'),
    scope: 'all',
  },
  {
    id: 'earnings.days_since_earnings',
    category: 'earnings',
    label: 'Days since earnings',
    definition: 'Registry earnings.days_since_earnings (NYSE trading days)',
    modes: CROSS,
    metric: plainMetric('earnings.days_since_earnings'),
    scope: 'all',
  },
  {
    id: 'earnings.surprise_pct',
    category: 'earnings',
    label: 'EPS surprise %',
    definition: 'Registry earnings.surprise_pct of the latest release',
    modes: CROSS,
    metric: plainMetric('earnings.surprise_pct'),
    scope: 'all',
  },
  {
    id: 'deals.spread_pct',
    category: 'earnings',
    label: 'Deal spread %',
    definition: 'Registry deals.spread_pct (merger targets only)',
    modes: CROSS,
    metric: plainMetric('deals.spread_pct'),
    scope: 'all',
  },
  {
    id: 'rates.tbill_3m',
    category: 'earnings',
    label: '3-month T-bill rate',
    definition: 'Registry rates.tbill_3m (the same for every stock: own-history atoms only)',
    modes: OWN,
    metric: plainMetric('rates.tbill_3m'),
    scope: 'all',
  },
  // Options signals as recorded (or rebuilt), any instrument with signals.
  ...(
    [
      ['iv30', '30-day implied volatility'],
      ['atm_iv', 'ATM implied volatility'],
      ['iv_rank_252d', 'IV rank (252 days)'],
      ['iv_rv_ratio', 'Implied ÷ realised volatility'],
      ['skew_30d', '30-day skew'],
      ['put_call_volume', 'Put/call volume ratio'],
      ['put_call_oi', 'Put/call open-interest ratio'],
      ['expected_move_5d_pct', 'Expected 5-day move %'],
    ] as const
  ).map(([field, label]): FactorSpec => ({
    id: `options.${field}`,
    category: 'options',
    label,
    definition: `Registry options.${field}, the latest recorded daily signal (at most 5 trading days old)`,
    // Fewer than 50 instruments have signals, so quintiles across the universe never form.
    modes: OWN,
    metric: plainMetric(`options.${field}`),
    scope: 'all',
  })),
  // Session values from that day's intraday bars (options universe only in v1).
  {
    id: 'session.first5_return',
    category: 'session',
    label: 'First 5 minutes return',
    definition: "Close of the session's first 5-minute bar ÷ the session open − 1",
    modes: OWN,
    scope: 'options_universe',
  },
  {
    id: 'session.first30_return',
    category: 'session',
    label: 'First 30 minutes return',
    definition: 'Close of the 5-minute bar ending 30 minutes after the open ÷ the session open − 1',
    modes: OWN,
    scope: 'options_universe',
  },
  {
    id: 'session.range_pct',
    category: 'session',
    label: 'Session range %',
    definition: 'Session high ÷ session low − 1, regular session',
    modes: OWN,
    scope: 'options_universe',
  },
  {
    id: 'session.close_position',
    category: 'session',
    label: 'Close in session range',
    definition: '(Close − session low) ÷ (session high − session low): 0 at the low, 1 at the high',
    modes: OWN,
    scope: 'options_universe',
  },
];

const BY_ID = new Map(FACTOR_CATALOGUE_V1.map((f) => [f.id, f]));

export function factorSpec(id: string): FactorSpec | undefined {
  return BY_ID.get(id);
}

export const factorsIn = (category: FactorCategory) =>
  FACTOR_CATALOGUE_V1.filter((f) => f.category === category);

export type FactorValues = Record<string, number>;

/** The fewest known values that day for a quintile atom to form (§4). */
export const MIN_CROSS_SECTION = 50;
/** Own-history atoms: the trailing window and the fewest known values in it (§4). */
export const OWN_HISTORY_WINDOW = 252;
export const MIN_OWN_HISTORY = 120;

/** Daily bars a snapshot needs before its first date: 252-day windows, 200-day SMA and filings' share basis. */
export const SNAPSHOT_WARMUP_CALENDAR_DAYS = 800;

/** The daily series the price and fundamental factors read for one instrument. */
export function factorSeries(instrumentId: string): DailySeries[] {
  const out: DailySeries[] = [dailyClose(instrumentId, 260)];
  for (const f of FACTOR_CATALOGUE_V1)
    if (f.metric) out.push(...metricRequirements(f.metric, instrumentId));
  return out;
}

const DAY = 86_400_000;

/**
 * Point-in-time filings indexed by field, for a fast "latest as of" lookup: a
 * daily snapshot asks hundreds of thousands of times, and the plain scan of
 * `latestObservation` is linear in a company's filing history. Same answer:
 * the last observation of the field, in availability order, known by then and
 * describing a period no more than FUNDAMENTAL_MAX_AGE_DAYS old.
 */
export class FilingIndex {
  private readonly byField = new Map<string, { at: number[]; obs: FundamentalObservation[] }>();

  constructor(list: readonly FundamentalObservation[]) {
    // Availability order (stable, so equal times keep the loader's order, as latestObservation reads them).
    const sorted = [...list].sort(
      (a, b) => Date.parse(a.availableFrom) - Date.parse(b.availableFrom),
    );
    for (const o of sorted) {
      const entry = this.byField.get(o.field) ?? { at: [], obs: [] };
      entry.at.push(Date.parse(o.availableFrom));
      entry.obs.push(o);
      this.byField.set(o.field, entry);
    }
  }

  private lastIndex(field: string, asOfMs: number): number {
    const entry = this.byField.get(field);
    if (!entry) return -1;
    let lo = 0;
    let hi = entry.at.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if ((entry.at[mid] as number) <= asOfMs) {
        found = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  }

  latest(field: FundamentalField | string, asOfMs: number): FundamentalPoint | undefined {
    const i = this.lastIndex(field, asOfMs);
    if (i < 0) return undefined;
    const found = this.byField.get(field)?.obs[i] as FundamentalObservation;
    if (Date.parse(`${found.periodEnd}T00:00:00Z`) < asOfMs - FUNDAMENTAL_MAX_AGE_DAYS * DAY)
      return undefined;
    return {
      value: new Decimal(found.value),
      periodEnd: found.periodEnd,
      availableFrom: found.availableFrom,
    };
  }

  /**
   * The value of a field for the period ending about `periodEnd` (±20 days),
   * the latest such observation known by `asOfMs`: a restated year-ago figure
   * replaces the original only once the restatement was filed.
   */
  forPeriod(field: string, periodEnd: string, asOfMs: number): number | undefined {
    const entry = this.byField.get(field);
    if (!entry) return undefined;
    const target = Date.parse(`${periodEnd}T00:00:00Z`);
    let out: number | undefined;
    for (let i = 0; i < entry.at.length; i++) {
      if ((entry.at[i] as number) > asOfMs) break;
      const o = entry.obs[i] as FundamentalObservation;
      if (Math.abs(Date.parse(`${o.periodEnd}T00:00:00Z`) - target) <= 20 * DAY)
        out = Number(o.value);
    }
    return out;
  }
}

/** A reader whose `fundamental` answers from a FilingIndex; everything else from `base`. */
export function withFilingIndex(
  base: MetricReader,
  instrumentId: string,
  index: FilingIndex | undefined,
  nowMs: () => number,
): MetricReader {
  // Methods bound so a class-based reader (the back test's market view) keeps its `this`.
  const bind = <K extends keyof MetricReader>(k: K) =>
    (typeof base[k] === 'function'
      ? (base[k] as (...a: unknown[]) => unknown).bind(base)
      : undefined) as MetricReader[K];
  const reader: MetricReader = {
    value: bind('value'),
    ...(base.valueAt ? { valueAt: bind('valueAt') } : {}),
    ...(base.option ? { option: bind('option') } : {}),
    ...(base.event ? { event: bind('event') } : {}),
    ...(base.session ? { session: bind('session') } : {}),
  };
  if (index)
    reader.fundamental = (id, field, barsBack) =>
      barsBack === 0 && id === instrumentId
        ? index.latest(field, nowMs())
        : base.fundamental?.(id, field, barsBack);
  return reader;
}

const num = (d: Decimal | undefined): number | undefined => {
  const n = d?.toNumber();
  return n !== undefined && Number.isFinite(n) ? n : undefined;
};

/** Daily bars as plain numbers, oldest first, up to and including the evaluated day. */
export interface DailyNumbers {
  close: readonly number[];
  volume: readonly number[];
  /** Index of the evaluated day's bar. */
  at: number;
}

/**
 * One instrument's daily factors (all but the session ones) as of the
 * reader's current bar. `daily` holds the same adjusted bars as plain
 * numbers, for the factors computed here rather than by the registry.
 */
export function computeDailyFactors(
  instrumentId: string,
  reader: MetricReader,
  daily: DailyNumbers,
  filings: FilingIndex | undefined,
  nowMs: number,
  categories: ReadonlySet<FactorCategory> = new Set(FACTOR_CATEGORIES),
): FactorValues {
  const out: FactorValues = {};
  const set = (id: string, v: number | undefined) => {
    if (v !== undefined && Number.isFinite(v)) out[id] = v;
  };
  const { close, volume, at } = daily;
  for (const f of FACTOR_CATALOGUE_V1) {
    if (!categories.has(f.category) || f.category === 'session') continue;
    if (f.metric) {
      set(f.id, num(computeMetric(f.metric, instrumentId, reader)));
      continue;
    }
    switch (f.id) {
      case 'return_5d': {
        const before = close[at - 5];
        const now = close[at];
        if (before !== undefined && now !== undefined && before > 0) set(f.id, now / before - 1);
        break;
      }
      case 'dist_52w_high': {
        if (at < 251) break;
        let high = 0;
        for (let k = at - 251; k <= at; k++) high = Math.max(high, close[k] as number);
        const now = close[at] as number;
        if (high > 0 && now > 0) set(f.id, now / high - 1);
        break;
      }
      case 'volume_ratio_60': {
        if (at < 60) break;
        let sum = 0;
        for (let k = at - 60; k < at; k++) sum += volume[k] as number;
        const avg = sum / 60;
        if (avg > 0) set(f.id, (volume[at] as number) / avg);
        break;
      }
      case 'ebitda_ttm':
      case 'cash':
      case 'debt':
      case 'equity':
        set(f.id, num(filings?.latest(f.id, nowMs)?.value));
        break;
      case 'revenue_growth_yoy':
        set(f.id, revenueGrowth(filings, nowMs));
        break;
      case 'fcf_margin':
        set(f.id, fcfMargin(filings, nowMs));
        break;
    }
  }
  return out;
}

/** Revenue (TTM) ÷ revenue (TTM) for the period a year earlier − 1; unknown when either is. */
export function revenueGrowth(filings: FilingIndex | undefined, nowMs: number): number | undefined {
  const now = filings?.latest('revenue_ttm', nowMs);
  if (!filings || !now) return undefined;
  const end = new Date(Date.parse(`${now.periodEnd}T00:00:00Z`) - 365 * DAY)
    .toISOString()
    .slice(0, 10);
  const before = filings.forPeriod('revenue_ttm', end, nowMs);
  if (before === undefined || !(before > 0)) return undefined;
  return now.value.toNumber() / before - 1;
}

/**
 * (Operating cash flow − capital expenditure) ÷ revenue, each trailing twelve
 * months for the same period; unknown when any input is, or the periods differ.
 */
export function fcfMargin(filings: FilingIndex | undefined, nowMs: number): number | undefined {
  if (!filings) return undefined;
  const revenue = filings.latest('revenue_ttm', nowMs);
  const ocf = filings.latest('ocf_ttm', nowMs);
  const capex = filings.latest('capex_ttm', nowMs);
  if (!revenue || !ocf || !capex) return undefined;
  if (revenue.periodEnd !== ocf.periodEnd || ocf.periodEnd !== capex.periodEnd) return undefined;
  if (!revenue.value.gt(0)) return undefined;
  return ocf.value.minus(capex.value).div(revenue.value).toNumber();
}

/**
 * The session factors of one trading day from its regular-session intraday
 * bars (any size up to 5 minutes; 5-minute in practice). Unknown without
 * bars for that day, or when the first bar doesn't start at the open.
 */
export function sessionFactors(date: string, bars: readonly Bar[]): FactorValues {
  const out: FactorValues = {};
  const session = regularSession(date);
  if (!session || bars.length === 0) return out;
  const open = Date.parse(session.open);
  const closeMs = Date.parse(session.close);
  const inSession = bars.filter((b) => Date.parse(b.start) >= open && Date.parse(b.end) <= closeMs);
  const first = inSession[0];
  if (!first) return out;
  const sessionOpen = first.open.toNumber();
  if (!(sessionOpen > 0)) return out;
  const set = (id: string, v: number) => {
    if (Number.isFinite(v)) out[id] = v;
  };
  // The first bar must be the opening bar for the opening returns to mean what they say.
  if (Date.parse(first.start) === open) {
    const firstEndingBy = (minutes: number) => {
      let bar: Bar | undefined;
      for (const b of inSession) if (Date.parse(b.end) <= open + minutes * 60_000) bar = b;
      return bar;
    };
    const b5 = firstEndingBy(5);
    if (b5 && Date.parse(b5.end) === open + 5 * 60_000)
      set('session.first5_return', b5.close.toNumber() / sessionOpen - 1);
    const b30 = firstEndingBy(30);
    if (b30 && Date.parse(b30.end) === open + 30 * 60_000)
      set('session.first30_return', b30.close.toNumber() / sessionOpen - 1);
  }
  let high = -Infinity;
  let low = Infinity;
  for (const b of inSession) {
    high = Math.max(high, b.high.toNumber());
    low = Math.min(low, b.low.toNumber());
  }
  const last = (inSession.at(-1) as Bar).close.toNumber();
  if (low > 0) set('session.range_pct', high / low - 1);
  if (high > low) set('session.close_position', (last - low) / (high - low));
  return out;
}

/**
 * The day's bar as ratios to the previous close (adjusted): what the miner
 * labels outcomes and the event study reads, independent of the adjustment
 * basis the backfill happened to fetch (a later split or dividend rescales
 * every adjusted price, never these ratios).
 */
export interface BarRatios {
  closeRet: number;
  highRel: number;
  lowRel: number;
}

export function barRatios(
  prevClose: number | undefined,
  bar: { close: number; high: number; low: number },
): BarRatios | undefined {
  if (prevClose === undefined || !(prevClose > 0)) return undefined;
  const r = {
    closeRet: bar.close / prevClose - 1,
    highRel: bar.high / prevClose - 1,
    lowRel: bar.low / prevClose - 1,
  };
  return Number.isFinite(r.closeRet) && Number.isFinite(r.highRel) && Number.isFinite(r.lowRel)
    ? r
    : undefined;
}

/** Per factor category, the factor ids it holds (the coverage report's grouping). */
export function catalogueByCategory(): Record<FactorCategory, string[]> {
  const out = Object.fromEntries(FACTOR_CATEGORIES.map((c) => [c, [] as string[]])) as Record<
    FactorCategory,
    string[]
  >;
  for (const f of FACTOR_CATALOGUE_V1) out[f.category].push(f.id);
  return out;
}
