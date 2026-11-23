import { latestRelease, rateSeriesByMetric, type EventData } from '@tm/domain';

/**
 * Whether a run's dates are covered by the event data it reads (free data
 * feeds brief v1 §6): a run entirely before the first earnings release on
 * record, before the deal tracker's history, or before the first stored
 * T-bill rate fails with a named message, as options data does.
 */

/** The message for a run that ends before a stock's first earnings release, or undefined. */
export function earningsBeforeFirstDate(
  symbol: string,
  data: EventData,
  instrumentId: string,
  to: string,
): string | undefined {
  const first = data.earnings.get(instrumentId)?.[0];
  if (!first)
    return `No earnings data for ${symbol} yet: the recording starts with the next release`;
  return first.announcedDate > to
    ? `No earnings data for ${symbol} before ${first.announcedDate}`
    : undefined;
}

/** The message for a run that ends before the deal tracker's history starts, or undefined. */
export function dealsBeforeFirstDate(data: EventData, to: string): string | undefined {
  if (!data.dealsFrom)
    return "No deal data yet: the deal tracker's first EDGAR scan hasn't finished";
  return data.dealsFrom > to ? `No deal data before ${data.dealsFrom}` : undefined;
}

/**
 * The message for a run that ends before the first stored value of a rates
 * metric (the T-bill rate, or a regime series from N322), or undefined.
 */
export function ratesBeforeFirstDate(
  data: EventData,
  to: string,
  metric = 'rates.tbill_3m',
): string | undefined {
  if (metric === 'rates.tbill_3m') {
    const first = data.rates[0]?.date;
    if (!first) return 'No T-bill rates yet: they are stored with the next FRED fetch';
    return first > to ? `No T-bill rates before ${first}` : undefined;
  }
  const spec = rateSeriesByMetric(metric);
  if (!spec) return undefined;
  const first = data.rateSeries?.get(metric)?.[0]?.date;
  if (!first) return `No ${spec.label} data yet: it is stored with the next FRED fetch`;
  return first > to ? `No ${spec.label} data before ${first}` : undefined;
}

/**
 * The message for a run that ends before a stock's first published FINRA
 * short interest (N323), or undefined.
 */
export function shortBeforeFirstDate(
  symbol: string,
  data: EventData,
  instrumentId: string,
  to: string,
): string | undefined {
  const first = data.shortInterest?.get(instrumentId)?.[0];
  if (!first) return `No short interest data for ${symbol} yet`;
  return first.availableDate > to
    ? `No short interest data for ${symbol} before ${first.availableDate}`
    : undefined;
}

/** "AAPL: earnings data on 180 of 252 bars (72 without)" for each stock read. */
export function describeEarningsCoverage(
  steps: readonly number[],
  data: EventData,
  symbol: (id: string) => string,
): { instrumentId: string; text: string }[] {
  return [...data.earnings].map(([instrumentId, list]) => {
    const withData = steps.filter((t) => latestRelease(list, t) !== undefined).length;
    return {
      instrumentId,
      text: `${symbol(instrumentId)}: earnings data on ${withData} of ${steps.length} bars (${steps.length - withData} without)`,
    };
  });
}
