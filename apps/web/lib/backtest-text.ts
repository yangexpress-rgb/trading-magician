import type { BacktestRunStatusDto, BacktestRunSummaryDto, BacktestTradeDto } from '@tm/contracts';
import type { BacktestMetrics } from '@tm/backtest';
import type { Tone } from '@tm/ui';

/** Words for back-test runs and results (Design v1.0 §7.3). */

export const RUN_STATUS: Record<BacktestRunStatusDto, { label: string; tone: Tone }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'info' },
  completed: { label: 'Completed', tone: 'ok' },
  failed: { label: 'Failed', tone: 'danger' },
  canceled: { label: 'Canceled', tone: 'neutral' },
};

export const isActive = (status: BacktestRunStatusDto) =>
  status === 'queued' || status === 'running';

const MARKET_ZONE = 'America/New_York';
const dateFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});
const dateTimeFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: MARKET_ZONE,
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

/** A market timestamp as a date (daily bars) or date and time (hourly), in New York time. */
export function formatMarketTime(iso: string | null, interval: '1d' | '1h'): string {
  if (!iso) return '—';
  return (interval === '1d' ? dateFmt : dateTimeFmt).format(new Date(iso));
}

/** A calendar date (`YYYY-MM-DD`) as written in the UI. */
export function formatDay(day: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(new Date(`${day}T00:00:00Z`));
}

export function formatMoney(value: string | number, currency = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(Number(value));
}

/** A signed amount, so gains and losses read without colour. */
export function formatSignedMoney(value: string | number, currency = 'USD'): string {
  const n = Number(value);
  const s = formatMoney(Math.abs(n), currency);
  return n > 0 ? `+${s}` : n < 0 ? `−${s}` : s;
}

export function formatPct(value: string | number | null, signed = false): string {
  if (value === null) return '—';
  const n = Number(value);
  const body = `${Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  if (!signed) return n < 0 ? `−${body}` : body;
  return n > 0 ? `+${body}` : n < 0 ? `−${body}` : body;
}

export interface MetricTile {
  label: string;
  value: string;
  detail?: string;
}

/** The §7.3 headline numbers. */
export function metricTiles(m: BacktestMetrics, currency = 'USD'): MetricTile[] {
  const costs = Number(m.commission) + Number(m.slippage) + Number(m.borrow);
  return [
    {
      label: 'Net return',
      value: formatPct(m.netReturnPct, true),
      detail: `${formatMoney(m.initialCapital, currency)} → ${formatMoney(m.finalEquity, currency)}`,
    },
    { label: 'Gross return', value: formatPct(m.grossReturnPct, true), detail: 'Before costs' },
    { label: 'Max drawdown', value: formatPct(m.maxDrawdownPct) },
    {
      label: 'Win rate',
      value: formatPct(m.winRatePct),
      detail: `${m.closedCycles} closed ${m.closedCycles === 1 ? 'cycle' : 'cycles'}`,
    },
    {
      label: 'Profit factor',
      value: m.profitFactor ?? '—',
      detail: m.profitFactor === null ? 'No losing cycles' : 'Gains ÷ losses',
    },
    {
      label: 'Sharpe ratio',
      value: m.sharpe ?? '—',
      detail: m.sharpe === null ? 'Needs 20 trading days' : 'Annualised, daily returns',
    },
    {
      label: 'Cycles',
      value: String(m.cycles),
      detail: `${m.orders} ${m.orders === 1 ? 'order' : 'orders'}, ${m.fills} ${m.fills === 1 ? 'fill' : 'fills'}`,
    },
    {
      label: 'Costs',
      value: formatMoney(costs, currency),
      detail: `Commission ${formatMoney(m.commission, currency)}, slippage ${formatMoney(m.slippage, currency)}, borrow ${formatMoney(m.borrow, currency)}`,
    },
    { label: 'Average exposure', value: formatPct(m.averageExposurePct), detail: 'Of equity' },
  ];
}

/** One line naming what a run tested: version, dates and resolution. */
export function describeRun(run: Pick<BacktestRunSummaryDto, 'versionNo' | 'inputs'>): string {
  const { inputs } = run;
  return `Version ${run.versionNo} · ${formatDay(inputs.from)} to ${formatDay(inputs.to)} · ${
    inputs.interval === '1d' ? 'Daily' : 'Hourly'
  } bars`;
}

export interface ChartGeometry {
  path: string;
  min: number;
  max: number;
}

/**
 * An SVG polyline path for a series scaled into a box, with a little headroom.
 * Pure so it can be tested; the chart component only draws it.
 */
export function linePath(values: readonly number[], width: number, height: number): ChartGeometry {
  if (values.length === 0) return { path: '', min: 0, max: 0 };
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (min === max) {
    min -= 1;
    max += 1;
  }
  const pad = (max - min) * 0.05;
  const lo = min - pad;
  const span = max + pad - lo;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const path = values
    .map((v, i) => {
      const x = values.length > 1 ? i * step : width / 2;
      const y = height - ((v - lo) / span) * height;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(' ');
  return { path, min: Math.min(...values), max: Math.max(...values) };
}

/** Thins a long series to at most `limit` points, keeping the first and last. */
export function thin<T>(points: readonly T[], limit = 600): T[] {
  if (points.length <= limit) return [...points];
  const step = (points.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, i) => points[Math.round(i * step)] as T);
}

const CAP_LABELS = {
  max_order_size: 'the maximum order size',
  max_exposure: 'the maximum exposure',
  buying_power: 'buying power',
} as const;

/**
 * How a risk-based Entry quantity was worked out (v1.2 item 9), so it can be
 * checked by hand: "Risk 1% of $100,000.00 = $1,000.00 ÷ stop distance 8.2468
 * (2 × ATR(20) 4.1234) = 121 shares".
 */
export function sizingText(sizing: NonNullable<BacktestTradeDto['sizing']>): string[] {
  const dollars = sizing.riskAmount !== undefined;
  const budget = dollars
    ? Number(sizing.riskAmount)
    : (Number(sizing.equity) * Number(sizing.riskPct)) / 100;
  const lines = [
    dollars
      ? `Risk ${formatMoney(sizing.riskAmount ?? '0')}`
      : `Risk ${sizing.riskPct}% of ${formatMoney(sizing.equity)} equity = ${formatMoney(budget)}`,
    `Stop distance ${sizing.stopDistance} = ${sizing.atrMultiple} × ATR(${sizing.atrPeriod}) ${sizing.atr}`,
    `${formatMoney(budget)} ÷ ${sizing.stopDistance} = ${sizing.riskQuantity} shares`,
  ];
  if (sizing.cappedBy && sizing.quantity !== sizing.riskQuantity) {
    lines.push(
      `Capped at ${sizing.quantity} by ${CAP_LABELS[sizing.cappedBy as keyof typeof CAP_LABELS] ?? sizing.cappedBy}`,
    );
  }
  return lines;
}

/** The fixed ATR stop of a trade (v1.2 item 9), e.g. "Stop 391.23 = entry 399.48 − 2 × ATR 4.12". */
export function atrStopText(stop: NonNullable<BacktestTradeDto['atrStop']>): string {
  const sign = stop.direction === 'short' ? '+' : '−';
  return `Stop ${stop.level} = entry ${stop.entryPrice} ${sign} ${stop.atrMultiple} × ATR ${stop.atr}`;
}

export type TradeDirection = 'long' | 'short' | 'long_short';

export const DIRECTION_WORDS: Record<TradeDirection, string> = {
  long: 'Long',
  short: 'Short',
  long_short: 'Long and short',
};

/**
 * A trade's direction (v1.2 item 8), from the Entry legs it filled: all short
 * sales is short, a mix of buys and short sales (a pair) is long and short,
 * else long. Without filled Entry legs, as the back test recorded it.
 */
export function tradeDirection(t: {
  direction?: 'long' | 'short' | null | undefined;
  legs: readonly { phase: string; side: string }[];
}): TradeDirection {
  const entries = t.legs.filter((l) => l.phase === 'entry');
  const short = entries.filter((l) => l.side === 'sell_short').length;
  if (entries.length === 0) return t.direction ?? 'long';
  if (short === entries.length) return 'short';
  return short > 0 ? 'long_short' : 'long';
}
