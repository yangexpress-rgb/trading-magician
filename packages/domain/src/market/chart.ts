import { addDays, nyDate } from './calendar';

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

/** Inclusive New York dates a chart asks the feed for, ending on the day of `now`. */
export function chartWindow(range: ChartRange, now: Date): { from: string; to: string } {
  const to = nyDate(now);
  return { from: addDays(to, -RANGE_DAYS[range]), to };
}
