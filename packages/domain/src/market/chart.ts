import { addDays, isTradingDay, nyDate } from './calendar';

/**
 * Price chart windows for Quantitative Research (ADR 0029). A range is a
 * span of calendar time ending today in New York, except 1D: the latest
 * trading session, today's while the market is open. Finer bars are offered
 * only for shorter ranges, so a chart stays a few hundred bars.
 */

export const CHART_RANGES = ['1d', '1w', '1m', '3m', '6m', '1y', '5y'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export const CHART_INTERVALS = ['5m', '1h', '1d'] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

const RANGE_DAYS: Record<ChartRange, number> = {
  // Far enough back to reach the last session over a long weekend; trimmed to that session.
  '1d': 6,
  '1w': 7,
  '1m': 31,
  '3m': 92,
  '6m': 183,
  '1y': 366,
  '5y': 1827,
};

const ALLOWED: Record<ChartInterval, readonly ChartRange[]> = {
  '5m': ['1d', '1w'],
  '1h': ['1d', '1w', '1m', '3m'],
  '1d': ['1w', '1m', '3m', '6m', '1y', '5y'],
};

export function chartIntervalAllowed(range: ChartRange, interval: ChartInterval): boolean {
  return ALLOWED[interval].includes(range);
}

/** The bars a range opens with: 5-minute for a day, daily otherwise. */
export function defaultChartInterval(range: ChartRange): ChartInterval {
  return range === '1d' ? '5m' : '1d';
}

/**
 * Inclusive New York dates a chart asks the feed for, ending on the day of
 * `now`, or on an earlier `end` date the person went to (N194). A 1D chart
 * ending on a weekend or holiday shows the session before it.
 */
export function chartWindow(
  range: ChartRange,
  now: Date,
  end?: string | null,
): { from: string; to: string } {
  const today = nyDate(now);
  const to = end && end < today ? end : today;
  return { from: addDays(to, -RANGE_DAYS[range]), to };
}

/**
 * The end date one step earlier (-1) or later (+1) than `end` (N194): the
 * trading day before or after for 1D, otherwise the range's own length, so
 * stepping a 1W chart moves it a week. Null means today, and so does any
 * date that would reach today or later.
 */
export function stepChartEnd(
  range: ChartRange,
  end: string | null,
  direction: -1 | 1,
  now: Date,
): string | null {
  const today = nyDate(now);
  const from = end && end < today ? end : today;
  let next: string;
  if (range === '1d') {
    next = addDays(from, direction);
    while (!isTradingDay(next)) next = addDays(next, direction);
  } else {
    next = addDays(from, direction * RANGE_DAYS[range]);
  }
  return next >= today ? null : next;
}

/**
 * How much history is fetched at a time when the person scrolls a chart past
 * what it has (N195): a week of 5-minute bars, three months of hourly bars,
 * a year of daily bars. Each is the longest range its bars are offered for.
 */
export const CHART_HISTORY_CHUNK: Record<ChartInterval, ChartRange> = {
  '5m': '1w',
  '1h': '3m',
  '1d': '1y',
};

/** Calendar days a range covers, for working out the next chunk to fetch. */
export const chartRangeDays = (range: ChartRange): number => RANGE_DAYS[range];
