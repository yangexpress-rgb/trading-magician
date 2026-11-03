import { addDays, nyDate } from './calendar';

/**
 * Price chart windows for Quantitative Research (ADR 0029). A range is a
 * span of calendar time ending today in New York; hourly bars are offered
 * only for the shorter ranges so a chart stays a few hundred bars.
 */

export const CHART_RANGES = ['1w', '1m', '3m', '6m', '1y', '5y'] as const;
export type ChartRange = (typeof CHART_RANGES)[number];

export const CHART_INTERVALS = ['1d', '1h'] as const;
export type ChartInterval = (typeof CHART_INTERVALS)[number];

const RANGE_DAYS: Record<ChartRange, number> = {
  '1w': 7,
  '1m': 31,
  '3m': 92,
  '6m': 183,
  '1y': 366,
  '5y': 1827,
};

/** Hourly bars are available for these ranges only. */
export const HOURLY_RANGES: readonly ChartRange[] = ['1w', '1m', '3m'];

export function chartIntervalAllowed(range: ChartRange, interval: ChartInterval): boolean {
  return interval === '1d' || HOURLY_RANGES.includes(range);
}

/** Inclusive New York dates a chart covers, ending on the day of `now`. */
export function chartWindow(range: ChartRange, now: Date): { from: string; to: string } {
  const to = nyDate(now);
  return { from: addDays(to, -RANGE_DAYS[range]), to };
}
