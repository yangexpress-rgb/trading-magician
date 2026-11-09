import { addDays, nyDate, tradingDaysBetween } from '../market/calendar';

/**
 * Earnings data (free data feeds brief v1, ADR 0058): each reported quarter's
 * release from SEC EDGAR (an 8-K with Item 2.02), the time-series earnings
 * surprise (SUE) worked out from point-in-time quarterly EPS, and, when a
 * calendar provider is configured, the scheduled dates of coming releases.
 * EDGAR is the record of what happened; a calendar feed never overrides it.
 */

/** Where a stored SUE row came from: the build-time rebuild back to February 2024, or the daily scan. */
export type EarningsSource = 'rebuilt' | 'recorded';

/** One release as the engine reads it. */
export interface EarningsSignal {
  /** Quarter-end date the release reports on (YYYY-MM-DD). */
  fiscalQuarterEnd: string;
  /** The release instant: the 8-K's acceptance time (ISO). */
  announcedAt: string;
  /** The release's New York date. */
  announcedDate: string;
  reportedEps: number | null;
  /** Time-series SUE (§3); null until 8 prior quarterly differences exist. */
  sue: number | null;
  /** Reported vs a calendar feed's consensus estimate; null without one. */
  surprisePct: number | null;
  source: EarningsSource;
}

/** One scheduled release date from a calendar feed, with when the app first and last saw it. */
export interface ScheduledEarnings {
  date: string;
  firstSeenMs: number;
  lastSeenMs: number;
}

/** Quarterly differences the SUE's standard deviation is taken over (Bernard & Thomas 1989). */
export const SUE_DIFFERENCES = 8;

/** One quarter's EPS, oldest first in a series. */
export interface QuarterEps {
  quarterEnd: string;
  eps: number;
}

export interface SueResult {
  epsQ: number;
  epsQMinus4: number;
  /** Population standard deviation (÷ 8) of the 8 prior differences. */
  diffSd: number | null;
  sue: number | null;
}

const DAY = 86_400_000;
const daysApart = (a: string, b: string) => Math.round((Date.parse(b) - Date.parse(a)) / DAY);
/** Two quarter ends a year apart: 52 or 53 weeks, or a calendar year. */
const yearApart = (a: string, b: string) => {
  const d = daysApart(a, b);
  return d >= 350 && d <= 380;
};

/** Population standard deviation: the mean squared deviation over n, not n − 1. */
export function populationSd(values: readonly number[]): number {
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

/** Rounds away floating-point noise so 0.1 + 0.2 style sums compare as filed (EPS has cents). */
const clean = (v: number) => Math.round(v * 1e10) / 1e10;

/**
 * The time-series SUE of the last quarter in `series` (sorted by quarter end,
 * one value per quarter): (EPS this quarter − EPS the same quarter last
 * year) ÷ the population SD of the 8 previous such differences. Undefined
 * when the same quarter last year is missing; `sue` is null when fewer than
 * 8 prior differences exist or their SD is 0 (brief §3, §7.1).
 */
export function timeSeriesSue(series: readonly QuarterEps[]): SueResult | undefined {
  const at = series.length - 1;
  const diffAt = (i: number): number | undefined => {
    const q = series[i];
    const prior = series[i - 4];
    if (!q || !prior || !yearApart(prior.quarterEnd, q.quarterEnd)) return undefined;
    return clean(q.eps - prior.eps);
  };
  const current = series[at];
  const lastYear = series[at - 4];
  const diff = diffAt(at);
  if (!current || !lastYear || diff === undefined) return undefined;
  const prior: number[] = [];
  for (let k = 1; k <= SUE_DIFFERENCES; k++) {
    const d = diffAt(at - k);
    if (d === undefined) break;
    prior.push(d);
  }
  if (prior.length < SUE_DIFFERENCES)
    return { epsQ: current.eps, epsQMinus4: lastYear.eps, diffSd: null, sue: null };
  const sd = clean(populationSd(prior));
  return {
    epsQ: current.eps,
    epsQMinus4: lastYear.eps,
    diffSd: sd,
    sue: sd > 0 ? clean(diff / sd) : null,
  };
}

/** `(reported − estimated) ÷ |estimated|`; null without an estimate or with a zero one. */
export function surprisePct(reported: number | null, estimated: number | null): number | null {
  if (reported === null || estimated === null || estimated === 0) return null;
  return clean((reported - estimated) / Math.abs(estimated));
}

/** The latest release announced by `atMs`, or undefined. `list` is sorted by announcement. */
export function latestRelease(
  list: readonly EarningsSignal[] | undefined,
  atMs: number,
): EarningsSignal | undefined {
  if (!list) return undefined;
  let found: EarningsSignal | undefined;
  for (const r of list) {
    if (Date.parse(r.announcedAt) > atMs) break;
    found = r;
  }
  return found;
}

/** Calendar days from `from` to `to` (both YYYY-MM-DD). */
export const calendarDaysBetween = (from: string, to: string) => daysApart(from, to);

/** A scheduled date counts as reported once a release is visible this close to it. */
const SCHEDULE_MATCH_DAYS = 3;
/** A scheduled date not refreshed for this long had been dropped or moved by the feed. */
const SCHEDULE_STALE_DAYS = 3;

/**
 * NYSE trading days from `barDate` to the next scheduled release known at
 * `atMs` (calendar feed only): dates the feed listed by then and was still
 * listing, on or after the bar date, not already reported. Undefined in
 * EDGAR-only mode or with nothing scheduled.
 */
export function daysToNextEarnings(
  schedule: readonly ScheduledEarnings[] | undefined,
  releases: readonly EarningsSignal[] | undefined,
  atMs: number,
): number | undefined {
  if (!schedule || schedule.length === 0) return undefined;
  const barDate = nyDate(new Date(atMs));
  const reported = (releases ?? []).filter((r) => Date.parse(r.announcedAt) <= atMs);
  let best: string | undefined;
  for (const s of schedule) {
    if (s.firstSeenMs > atMs || s.lastSeenMs < atMs - SCHEDULE_STALE_DAYS * DAY) continue;
    if (s.date < barDate) continue;
    if (
      reported.some(
        (r) => Math.abs(calendarDaysBetween(r.announcedDate, s.date)) <= SCHEDULE_MATCH_DAYS,
      )
    )
      continue;
    if (!best || s.date < best) best = s.date;
  }
  return best === undefined ? undefined : tradingDaysBetween(barDate, best);
}

/**
 * NYSE trading days from the bar date to the next earnings date as a run
 * knew it then (N189): the calendar feed's next scheduled date while the feed
 * covered the stock; before the feed's first listing for it, the stock's
 * actual next release on EDGAR stands in, as companies announce their dates
 * weeks ahead (O137). Undefined when neither is known.
 */
export function daysToNextEarningsDate(
  schedule: readonly ScheduledEarnings[] | undefined,
  releases: readonly EarningsSignal[] | undefined,
  atMs: number,
): { days: number; standIn: boolean } | undefined {
  const scheduled = daysToNextEarnings(schedule, releases, atMs);
  if (scheduled !== undefined) return { days: scheduled, standIn: false };
  // The feed already listed this stock by then and has nothing coming: no stand-in.
  if (schedule?.some((s) => s.firstSeenMs <= atMs)) return undefined;
  const next = releases?.find((r) => Date.parse(r.announcedAt) > atMs);
  if (!next) return undefined;
  return { days: tradingDaysBetween(nyDate(new Date(atMs)), next.announcedDate), standIn: true };
}

/**
 * The fiscal quarter a release on `filedDate` reports: the latest known
 * quarter end before it (within 120 days), or, when the quarter's figures
 * aren't filed yet, the quarter after the latest known one.
 */
export function releaseQuarterEnd(
  knownQuarterEnds: readonly string[],
  filedDate: string,
): string | undefined {
  const before = knownQuarterEnds.filter((q) => q < filedDate).sort();
  const last = before.at(-1);
  if (!last) return undefined;
  const age = daysApart(last, filedDate);
  // A release usually comes 2 to 8 weeks after its quarter ends.
  if (age <= 75) return last;
  const next = nextQuarterEnd(last);
  if (next < filedDate && daysApart(next, filedDate) <= 120) return next;
  return age <= 120 ? last : undefined;
}

/** The quarter end three months after `end`, keeping a month-end quarter at month end. */
export function nextQuarterEnd(end: string): string {
  const [y, m, d] = end.split('-').map(Number) as [number, number, number];
  const monthEnd = d === new Date(Date.UTC(y, m, 0)).getUTCDate();
  const target = new Date(Date.UTC(y, m - 1 + 3, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth() + 1;
  const last = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  const day = monthEnd ? last : Math.min(d, last);
  // 52/53-week years end on a weekday near month end: 13 weeks on is close enough.
  if (!monthEnd) return addDays(end, 91);
  return `${ty}-${String(tm).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
