/**
 * Daily rates (free data feeds brief v1 §3, §5.4): FRED's 3-month Treasury
 * bill (DTB3), the risk-free rate the options computation already fetches,
 * stored so back tests can read it. Values are fractions: 0.0412 is 4.12%.
 *
 * Data inputs part 2, item A (N322, ADR 0110): five more FRED series in the
 * same table, market-regime values a strategy and the pattern factors read.
 */
export interface RatePoint {
  date: string;
  tbill3m: number;
}

/** One value of a FRED series on one date, as a fraction. */
export interface SeriesPoint {
  date: string;
  value: number;
}

/** The latest rate dated on or before `date`; `list` is sorted by date. */
export function rateOn<T extends { date: string }>(list: readonly T[] | undefined, date: string) {
  if (!list) return undefined;
  let lo = 0;
  let hi = list.length - 1;
  let found: T | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = list[mid] as T;
    if (p.date <= date) {
      found = p;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The first day stored rates go back to, matching the options history (brief D5). */
export const EVENT_HISTORY_FROM = '2024-02-01';

/** The first day the regime series are kept from (item A: 2016-01-01 or the series' start). */
export const RATE_SERIES_FROM = '2016-01-01';

export const RATE_SERIES = [
  {
    metric: 'rates.credit_spread_ig',
    fred: 'BAMLC0A0CM',
    column: 'credit_spread_ig',
    label: 'Investment-grade credit spread',
  },
  {
    metric: 'rates.credit_spread_hy',
    fred: 'BAMLH0A0HYM2',
    column: 'credit_spread_hy',
    label: 'High-yield credit spread',
  },
  {
    metric: 'rates.term_spread_10y2y',
    fred: 'T10Y2Y',
    column: 'term_spread_10y2y',
    label: '10-year minus 2-year Treasury yield',
  },
  { metric: 'rates.ust_10y', fred: 'DGS10', column: 'ust_10y', label: '10-year Treasury yield' },
  { metric: 'rates.ust_2y', fred: 'DGS2', column: 'ust_2y', label: '2-year Treasury yield' },
] as const;

export type RateSeriesSpec = (typeof RATE_SERIES)[number];
export type RateSeriesMetric = RateSeriesSpec['metric'];
export type RateSeriesColumn = RateSeriesSpec['column'];

export const rateSeriesByMetric = (metric: string): RateSeriesSpec | undefined =>
  RATE_SERIES.find((s) => s.metric === metric);
