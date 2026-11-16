'use client';

import type { YearRangeDto } from '@tm/contracts';
import { liveYearRange, nyDate, type RangeExtreme } from '@tm/domain';
import { useEffect, useMemo, useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { formatPrice, type Bar } from '@/lib/research-text';

const DAY_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const formatDay = (date: string) => DAY_FMT.format(new Date(`${date}T12:00:00Z`));
const daysAgo = (n: number) =>
  n === 0 ? 'today' : `${n.toLocaleString('en-US')} trading ${n === 1 ? 'day' : 'days'} ago`;
const signedPct = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(2)}%`;

/**
 * The stock's 52-week low and high on Price charts (N290): the stored
 * figures, rolled forward with today's bars while the chart shows them, so
 * a new low or high today counts at once.
 */
export function YearRangeLine({
  instrumentId,
  bars,
  latest,
}: {
  instrumentId: string;
  /** The chart's bars (split-adjusted, regular session). */
  bars: readonly Bar[];
  /** Whether the chart runs to today, so its last bars are today's prices. */
  latest: boolean;
}) {
  const [data, setData] = useState<YearRangeDto | null>(null);

  useEffect(() => {
    setData(null);
    let live = true;
    apiClient.research
      .yearRange(instrumentId)
      .then((d) => live && setData(d))
      .catch(() => live && setData({ instrumentId, range: null }));
    return () => {
      live = false;
    };
  }, [instrumentId]);

  const view = useMemo(() => {
    if (!data?.range || data.instrumentId !== instrumentId) return null;
    const today = nyDate(new Date());
    const todays = latest ? bars.filter((b) => nyDate(new Date(b.t)) === today) : [];
    return liveYearRange(
      data.range,
      todays.length > 0
        ? {
            date: today,
            low: Math.min(...todays.map((b) => b.low)),
            high: Math.max(...todays.map((b) => b.high)),
            last: todays.at(-1)?.close ?? null,
          }
        : null,
    );
  }, [data, instrumentId, bars, latest]);

  if (!data || data.instrumentId !== instrumentId) return null;
  if (!view)
    return (
      <p className="text-xs text-ink-muted" data-testid="year-range">
        No 52-week low and high yet: they are worked out a few minutes after a stock is first looked
        up, and need a year of prices.
      </p>
    );
  const part = (label: string, x: RangeExtreme, pct: number, word: string) => (
    <span>
      <span className="text-ink-muted">{label}</span>{' '}
      <span className="font-medium text-content tabular-nums">{formatPrice(x.price)}</span>{' '}
      <span className="text-ink-muted">
        on {formatDay(x.on)}, {daysAgo(x.days)} ({signedPct(pct)} {word})
      </span>
    </span>
  );
  return (
    <p
      className="mt-1 flex flex-wrap gap-x-4 gap-y-0.5 text-sm"
      data-testid="year-range"
      title={`Split-adjusted daily lows and highs of the last 252 sessions, as of ${formatDay(view.asOf)}${view.asOf === data.range?.asOf ? ' close' : ', with today’s prices so far'}. Updated after every close.`}
    >
      {part('52-week low', view.low, view.fromLowPct, 'above it')}
      {part('52-week high', view.high, view.fromHighPct, 'from it')}
    </p>
  );
}
