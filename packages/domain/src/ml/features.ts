import type Decimal from 'decimal.js';
import { addDays, isTradingDay, nextTradingDay } from '../market/calendar';
import { isPeriodEnd } from '../strategy/schedule';
import { computeMetric, dailyClose, type MetricReader } from '../strategy/metrics';
import type { MetricRef } from '../strategy/schema';

/**
 * Feature set v1 of the multi-factor ranker (ML brief v1 §6). Every feature
 * but one is a registry metric, worked out through the same point-in-time
 * reader a strategy condition uses, so a feature equals what a condition
 * would have read that day. The exception, distance from the 252-day high,
 * reads the same adjusted daily closes through the same reader.
 */

export const FEATURE_SET_V1_VERSION = 1;

export type FeatureSource = 'daily bars' | 'EDGAR replay' | 'events store';

export interface FeatureSpec {
  name: string;
  /** The registry metric it reads; absent for a feature computed from closes here. */
  metric?: MetricRef;
  source: FeatureSource;
  definition: string;
}

export const FEATURE_SET_V1: readonly FeatureSpec[] = [
  {
    name: 'mom_12_1',
    metric: { metric: 'return', params: { lookbackMonths: '12', skipMonths: '1' } },
    source: 'daily bars',
    definition: 'Return from 252 to 21 trading days ago (adjusted closes)',
  },
  {
    name: 'mom_6_1',
    metric: { metric: 'return', params: { lookbackMonths: '6', skipMonths: '1' } },
    source: 'daily bars',
    definition: 'Return from 126 to 21 trading days ago',
  },
  {
    name: 'mom_3_1',
    metric: { metric: 'return', params: { lookbackMonths: '3', skipMonths: '1' } },
    source: 'daily bars',
    definition: 'Return from 63 to 21 trading days ago',
  },
  {
    name: 'rev_1m',
    metric: { metric: 'return', params: { lookbackMonths: '1', skipMonths: '0' } },
    source: 'daily bars',
    definition: 'Return over the last 21 trading days',
  },
  {
    name: 'vol_60',
    metric: { metric: 'volatility', params: { window: 60 } },
    source: 'daily bars',
    definition: 'Annualised sample SD of daily returns, last 60 trading days',
  },
  {
    name: 'rsi_14',
    metric: { metric: 'rsi', params: { period: 14, interval: '1d' } },
    source: 'daily bars',
    definition: 'RSI(14) of daily adjusted closes',
  },
  {
    name: 'dist_high_252',
    source: 'daily bars',
    definition: 'Close ÷ highest adjusted close of the last 252 trading days − 1',
  },
  {
    name: 'pe',
    metric: { metric: 'pe', params: {} },
    source: 'EDGAR replay',
    definition: "The app's P/E metric",
  },
  {
    name: 'earnings_yield',
    metric: { metric: 'earnings_yield', params: {} },
    source: 'EDGAR replay',
    definition: "The app's earnings-yield metric",
  },
  {
    name: 'dividend_yield',
    metric: { metric: 'dividend_yield', params: {} },
    source: 'EDGAR replay',
    definition: "The app's dividend-yield metric",
  },
  {
    name: 'sue',
    metric: { metric: 'earnings.sue_ts', params: {} },
    source: 'events store',
    definition: 'Time-series SUE of the latest release (earnings.sue_ts)',
  },
];

export const FEATURE_NAMES_V1 = FEATURE_SET_V1.map((f) => f.name);

/** Trading days in the 52-week high window. */
export const HIGH_WINDOW = 252;

/** Close ÷ the highest adjusted close of the last 252 bars (today's included) − 1. */
export function distanceFromHigh(
  instrumentId: string,
  r: MetricReader,
  barsBack = 0,
): Decimal | undefined {
  const series = dailyClose(instrumentId);
  const close = r.value(series, barsBack);
  if (!close || close.lte(0)) return undefined;
  let high = close;
  for (let k = 1; k < HIGH_WINDOW; k++) {
    const v = r.value(series, barsBack + k);
    if (!v) return undefined;
    if (v.gt(high)) high = v;
  }
  return close.div(high).minus(1);
}

export type FeatureValues = Record<string, number | null>;

/** One member's raw feature values at the reader's current bar; unknown is null, never 0. */
export function computeFeatures(
  instrumentId: string,
  r: MetricReader,
  features: readonly FeatureSpec[] = FEATURE_SET_V1,
): FeatureValues {
  const out: FeatureValues = {};
  for (const f of features) {
    const v = f.metric
      ? computeMetric(f.metric, instrumentId, r)
      : distanceFromHigh(instrumentId, r);
    const n = v?.toNumber();
    out[f.name] = n !== undefined && Number.isFinite(n) ? n : null;
  }
  return out;
}

/**
 * The percentile of sorted values with linear interpolation between the two
 * nearest ranks (numpy's default), `q` from 0 to 1.
 */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = sorted[lo] as number;
  const b = sorted[hi] as number;
  return a + (b - a) * (pos - lo);
}

/**
 * The per-date cross-sectional transform (brief §6): winsorise at the 1st and
 * 99th percentile of the members with a value, then z-score with their mean
 * and sample SD (n − 1). Nulls stay null. With fewer than two values, or no
 * spread, every value is null: there is nothing to rank by.
 */
export function winsorisedZScores(values: readonly (number | null)[]): (number | null)[] {
  const present = values.filter((v): v is number => v !== null && Number.isFinite(v));
  if (present.length < 2) return values.map(() => null);
  const sorted = [...present].sort((a, b) => a - b);
  const low = percentile(sorted, 0.01);
  const high = percentile(sorted, 0.99);
  const clip = (v: number) => Math.min(high, Math.max(low, v));
  const clipped = present.map(clip);
  const mean = clipped.reduce((a, v) => a + v, 0) / clipped.length;
  const ss = clipped.reduce((a, v) => a + (v - mean) ** 2, 0);
  const sd = Math.sqrt(ss / (clipped.length - 1));
  if (!(sd > 0)) return values.map(() => null);
  return values.map((v) => (v === null || !Number.isFinite(v) ? null : (clip(v) - mean) / sd));
}

/** Applies the transform feature by feature across one date's members. */
export function transformCrossSection(
  rows: readonly FeatureValues[],
  names: readonly string[] = FEATURE_NAMES_V1,
): FeatureValues[] {
  const out: FeatureValues[] = rows.map(() => ({}));
  for (const name of names) {
    const z = winsorisedZScores(rows.map((r) => r[name] ?? null));
    z.forEach((v, i) => ((out[i] as FeatureValues)[name] = v));
  }
  return out;
}

/** Whether every feature has a value: only such members get a prediction (brief §6). */
export const isComplete = (row: FeatureValues, names: readonly string[] = FEATURE_NAMES_V1) =>
  names.every((n) => row[n] !== null && row[n] !== undefined);

/** Prediction dates (brief §7): the last trading day of each month, from `from` to `to` inclusive. */
export function predictionDates(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1))
    if (isTradingDay(d) && isPeriodEnd('monthEnd', d)) out.push(d);
  return out;
}

/** The label horizon in trading days (brief §7). */
export const LABEL_HORIZON_DAYS = 21;

/** The trading day `n` trading days after `date`: where a label's window ends. */
export function tradingDayAfter(date: string, n = LABEL_HORIZON_DAYS): string {
  let d = date;
  for (let i = 0; i < n; i++) d = nextTradingDay(d);
  return d;
}

/**
 * The earliest date at which at least `share` of the members had a value, per
 * feature (brief §5 availability report), or null when none did.
 */
export function featureAvailability(
  byDate: ReadonlyMap<string, readonly FeatureValues[]>,
  names: readonly string[] = FEATURE_NAMES_V1,
  share = 0.9,
): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  const dates = [...byDate.keys()].sort();
  for (const name of names) {
    out[name] = null;
    for (const d of dates) {
      const rows = byDate.get(d) ?? [];
      if (rows.length === 0) continue;
      const have = rows.filter((r) => r[name] !== null && r[name] !== undefined).length;
      if (have / rows.length >= share) {
        out[name] = d;
        break;
      }
    }
  }
  return out;
}
