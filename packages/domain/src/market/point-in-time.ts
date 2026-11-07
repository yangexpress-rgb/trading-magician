import Decimal from 'decimal.js';

/**
 * Point-in-time fundamentals (Design v1.2 item 6, ADR 0043). Each value a
 * company's filings support is stored as an observation that becomes visible
 * when the market could first know it: the filing's acceptance time, never
 * the end of the period it describes. A later restatement is a new
 * observation with its own, later time; the original is never overwritten.
 * Values are as originally filed, with per-share figures on the share basis
 * of the filing that made them known (earlier quarters are rescaled when a
 * filing shows a stock split).
 */

export const FUNDAMENTAL_FIELDS = [
  /** Diluted EPS, sum of the last four reported quarters (or the fiscal year when it just ended). */
  'eps_ttm',
  'revenue_ttm',
  'net_income_ttm',
  /** Operating income plus depreciation and amortization, trailing twelve months. */
  'ebitda_ttm',
  /** Cash dividends declared per share, trailing twelve months. */
  'dps_ttm',
  /** Total shareholders' equity (excluding non-controlling interests), latest balance sheet. */
  'equity',
  /** Common shares outstanding (cover page), every class added up. */
  'shares',
  /** Long-term debt including its current portion, plus short-term borrowings. */
  'debt',
  'preferred',
  'minority_interest',
  /** Cash and cash equivalents. */
  'cash',
  /** Consecutive years of higher annual dividends per share, ending with the latest year. */
  'dividend_streak',
] as const;
export type FundamentalField = (typeof FUNDAMENTAL_FIELDS)[number];

export interface FundamentalObservation {
  field: FundamentalField;
  /** A decimal string. */
  value: string;
  /** The end of the period the value describes (YYYY-MM-DD). */
  periodEnd: string;
  /** When the filing was accepted: the first instant the value can be used (UTC ISO). */
  availableFrom: string;
  /** The filing's accession number and form. */
  accession: string;
  form: string;
}

/** A value as the engine reads it. */
export interface FundamentalPoint {
  value: Decimal;
  periodEnd: string;
  availableFrom: string;
}

/**
 * Values describing a period that ended more than this long before the
 * evaluation date are too old to use: a company that stopped filing (or
 * stopped paying dividends and reporting them) has no value, not last
 * year's. Fifteen months: a year plus a 10-K's filing window.
 */
export const FUNDAMENTAL_MAX_AGE_DAYS = 456;

const DAY = 86_400_000;

/**
 * The observation of a field visible at `asOfMs`: the latest with
 * `availableFrom <= asOf` (principle 2: no lookahead), or undefined when
 * none is, or when it is too old. `list` is sorted by `availableFrom`.
 */
export function latestObservation(
  list: readonly FundamentalObservation[] | undefined,
  field: FundamentalField,
  asOfMs: number,
): FundamentalPoint | undefined {
  if (!list) return undefined;
  let found: FundamentalObservation | undefined;
  for (const o of list) {
    if (Date.parse(o.availableFrom) > asOfMs) break;
    if (o.field === field) found = o;
  }
  if (!found) return undefined;
  if (Date.parse(`${found.periodEnd}T00:00:00Z`) < asOfMs - FUNDAMENTAL_MAX_AGE_DAYS * DAY) {
    return undefined;
  }
  return {
    value: new Decimal(found.value),
    periodEnd: found.periodEnd,
    availableFrom: found.availableFrom,
  };
}

/** Sorts observations for `latestObservation`: by `availableFrom`, then field. */
export function sortObservations<T extends FundamentalObservation>(list: T[]): T[] {
  return list.sort(
    (a, b) =>
      Date.parse(a.availableFrom) - Date.parse(b.availableFrom) || a.field.localeCompare(b.field),
  );
}
