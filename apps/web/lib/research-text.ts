import type { ChartBar } from '@tm/contracts';
import type { ChartInterval, ChartRange } from '@tm/domain';

/** Quantitative Research wording and chart arithmetic (ADR 0029). */

export const RANGE_LABELS: Record<ChartRange, string> = {
  '1d': '1D',
  '1w': '1W',
  '1m': '1M',
  '3m': '3M',
  '6m': '6M',
  '1y': '1Y',
  '5y': '5Y',
};

export const RANGE_NAMES: Record<ChartRange, string> = {
  '1d': '1 day',
  '1w': '1 week',
  '1m': '1 month',
  '3m': '3 months',
  '6m': '6 months',
  '1y': '1 year',
  '5y': '5 years',
};

export const INTERVAL_LABELS: Record<ChartInterval, string> = {
  '5m': '5 min',
  '1h': 'Hourly',
  '1d': 'Daily',
};

const INTERVAL_NAMES: Record<ChartInterval, string> = {
  '5m': '5-minute',
  '1h': 'hourly',
  '1d': 'daily',
};

/** Why a kind of bar is greyed out for some ranges. */
export const INTERVAL_LIMITS: Record<ChartInterval, string> = {
  '5m': '5-minute bars are available for 1 day and 1 week',
  '1h': 'Hourly bars are available for ranges up to 3 months',
  '1d': 'Daily bars start at 1 week; a day uses 5-minute or hourly bars',
};

export interface Bar {
  t: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export const toBars = (rows: readonly ChartBar[]): Bar[] =>
  rows.map(([t, open, high, low, close, volume]) => ({ t, open, high, low, close, volume }));

export interface ChartSummary {
  last: number;
  first: number;
  change: number;
  changePct: number | null;
  high: number;
  low: number;
  lastAt: number;
}

/** Change over the shown range is measured from the first bar's open. */
export function summarize(bars: readonly Bar[]): ChartSummary | null {
  const first = bars[0];
  const last = bars.at(-1);
  if (!first || !last) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const b of bars) {
    if (b.high > high) high = b.high;
    if (b.low < low) low = b.low;
  }
  const change = last.close - first.open;
  return {
    last: last.close,
    first: first.open,
    change,
    changePct: first.open === 0 ? null : (change / first.open) * 100,
    high,
    low,
    lastAt: last.t,
  };
}

/**
 * Round axis values covering [min, max]: about `count` steps of 1, 2 or 5
 * times a power of ten, starting at or below min and ending at or above max.
 */
export function niceTicks(min: number, max: number, count = 5): number[] {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  if (min === max) {
    const pad = Math.abs(min) * 0.01 || 1;
    min -= pad;
    max += pad;
  }
  const raw = (max - min) / Math.max(1, count);
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * power).find((s) => s >= raw) ?? 10 * power;
  const start = Math.floor(min / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(10)));
  const top = ticks.at(-1) ?? start;
  if (top < max) ticks.push(Number((top + step).toFixed(10)));
  return ticks;
}

const NY = 'America/New_York';
const dayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const monthFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  month: 'short',
  year: 'numeric',
});
const shortDayFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  month: 'short',
  day: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  hour: 'numeric',
  minute: '2-digit',
});
const hourFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY,
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** A bar's time as shown in the readout: the day, or the day and hour in New York. */
export function formatBarTime(t: number, interval: ChartInterval): string {
  return interval === '1d' ? dayFmt.format(t) : `${hourFmt.format(t)} ET`;
}

/** A short axis label, coarser for longer ranges. */
export function formatAxisTime(t: number, range: ChartRange): string {
  if (range === '1d') return timeFmt.format(t);
  return range === '1y' || range === '5y' ? monthFmt.format(t) : shortDayFmt.format(t);
}

/** About `count` evenly spaced bar indexes for time labels, first and last included. */
export function timeTickIndexes(length: number, count = 6): number[] {
  if (length <= 0) return [];
  if (length <= count) return Array.from({ length }, (_, i) => i);
  const step = (length - 1) / (count - 1);
  return Array.from({ length: count }, (_, i) => Math.round(i * step));
}

export function formatPrice(value: number): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: value < 1 ? 4 : 2,
  }).format(value);
}

export function formatVolume(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(
    value,
  );
}

export function formatChange(change: number, pct: number | null): string {
  const sign = change > 0 ? '+' : change < 0 ? '−' : '';
  const money = formatPrice(Math.abs(change));
  const percent =
    pct === null
      ? ''
      : ` (${sign}${Math.abs(pct).toLocaleString('en-US', { maximumFractionDigits: 2 })}%)`;
  return `${sign}${money}${percent}`;
}

/** One sentence that says what the chart shows, for screen readers. */
export function describeChart(
  symbol: string,
  bars: readonly Bar[],
  range: ChartRange,
  interval: ChartInterval,
): string {
  const s = summarize(bars);
  if (!s) return `${symbol}: no prices in this range.`;
  const dir = s.change > 0 ? 'up' : s.change < 0 ? 'down' : 'unchanged';
  return (
    `${symbol}, ${INTERVAL_NAMES[interval]} prices over ${RANGE_NAMES[range]}: ` +
    `${dir} ${formatChange(s.change, s.changePct).replace(/^[+−]/, '')}, last ${formatPrice(s.last)}, ` +
    `high ${formatPrice(s.high)}, low ${formatPrice(s.low)}, ${bars.length} bars.`
  );
}
