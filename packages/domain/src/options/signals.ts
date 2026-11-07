import { addDays, isTradingDay, regularSession } from '../market/calendar';

/**
 * Options signals (options data brief v2, ADR 0047): one row of derived
 * values per underlying per trading day, worked out once from that day's
 * option chain and read by conditions, back tests and paper runs. Field
 * names are the contract: they are the database columns and, prefixed with
 * `options.`, the metric ids in the registry.
 */

export const OPTION_SIGNAL_FIELDS = [
  'iv30',
  'atm_iv',
  'expected_move_1d_pct',
  'expected_move_1d_usd',
  'expected_move_5d_pct',
  'expected_move_5d_usd',
  'straddle_move_pct',
  'iv_rank_252d',
  'iv_percentile_252d',
  'iv_rv_ratio',
  'skew_30d',
  'term_structure',
  'put_call_volume',
  'put_call_oi',
  'net_gex',
  'call_gex',
  'put_gex',
  'call_wall',
  'put_wall',
  'max_pain',
] as const;
export type OptionSignalField = (typeof OPTION_SIGNAL_FIELDS)[number];

/** Stored on the signal row for Research and the screener, not offered as condition metrics yet. */
export const OPTION_LEVEL_FIELDS = ['call_wall', 'put_wall', 'max_pain'] as const;

export type OptionSignalValues = Record<OptionSignalField, number | null>;

/** Where a signal row came from: the daily snapshot, or the history rebuild from option bars. */
export type OptionSignalSource = 'recorded' | 'rebuilt';

/** One underlying's signal row for one day, as the engine reads it. */
export interface OptionSignal {
  asOfDate: string;
  values: OptionSignalValues;
  source: OptionSignalSource;
  /** How many prior days of IV30 the rank and percentile were computed over. */
  ivHistoryDays: number;
}

/** A signal older than this many trading days is unknown (brief §5.3). */
export const OPTION_SIGNAL_MAX_AGE_TRADING_DAYS = 5;

/** Days of history kept (brief §3.5); configuration, this is the default. */
export const OPTIONS_HISTORY_DAYS_DEFAULT = 400;

/** IV rank and percentile window, and the history needed before they are known. */
export const IV_RANK_WINDOW = 252;
export const IV_RANK_MIN_HISTORY = 120;

/** The first instant a day's signal can be used: that day's regular close. */
export function signalAvailableFrom(asOfDate: string): number {
  const session = regularSession(asOfDate);
  return Date.parse(
    session?.close ?? `${asOfDate}T21:00:00Z`, // a non-trading day: after any close
  );
}

/** Trading days after `from` up to and including `to` (0 when the same day). */
export function tradingDaysBetween(from: string, to: string): number {
  let n = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) if (isTradingDay(d)) n++;
  return n;
}

/**
 * The signal visible at `atMs` (brief §5.3, principle 3): the latest whose
 * day has closed by then, and no more than five trading days old. A day's
 * row describes that day's close, so it is never used before the close,
 * including by an intraday bar of the same day. `list` is sorted by date.
 */
export function signalAt(
  list: readonly OptionSignal[] | undefined,
  atMs: number,
  nyDateOf: (ms: number) => string,
): OptionSignal | undefined {
  if (!list || list.length === 0) return undefined;
  let lo = 0;
  let hi = list.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (signalAvailableFrom((list[mid] as OptionSignal).asOfDate) <= atMs) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const s = found >= 0 ? list[found] : undefined;
  if (!s) return undefined;
  if (tradingDaysBetween(s.asOfDate, nyDateOf(atMs)) > OPTION_SIGNAL_MAX_AGE_TRADING_DAYS)
    return undefined;
  return s;
}

/**
 * IV rank and percentile (brief §4.3). `prior` are the IV30 values of the
 * `window` trading days before today (today itself is not in it): rank =
 * 100 × (today − low) ÷ (high − low), with today counted in the low and the
 * high; percentile = 100 × share of the prior days whose IV30 is at or below
 * today's. Both unknown until `minHistory` prior days exist, or when the
 * year's high equals its low.
 */
export function ivRankPercentile(
  today: number | null | undefined,
  prior: readonly number[],
  minHistory = IV_RANK_MIN_HISTORY,
): { rank: number | null; percentile: number | null; days: number } {
  const days = prior.length;
  if (today == null || !(today > 0) || days < minHistory || days === 0)
    return { rank: null, percentile: null, days };
  let low = today;
  let high = today;
  let atOrBelow = 0;
  for (const v of prior) {
    if (v < low) low = v;
    if (v > high) high = v;
    if (v <= today) atOrBelow++;
  }
  return {
    rank: high > low ? (100 * (today - low)) / (high - low) : null,
    percentile: (100 * atOrBelow) / days,
    days,
  };
}

/** Whether an expiry is a standard monthly: the third Friday, or the Thursday before it on a holiday. */
export function isMonthlyExpiry(date: string): boolean {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  const dom = d.getUTCDate();
  if (dow === 5) return dom >= 15 && dom <= 21;
  if (dow === 4) {
    const friday = addDays(date, 1);
    const fd = Number(friday.slice(8));
    return fd >= 15 && fd <= 21 && !isTradingDay(friday);
  }
  return false;
}

/** The underlyings recorded from the start (brief §2); the universe grows from here. */
export const OPTION_SEED_SYMBOLS = [
  'SPY',
  'QQQ',
  'DIA',
  'IWM',
  'AAPL',
  'MSFT',
  'NVDA',
  'AMZN',
  'META',
  'GOOGL',
  'TSLA',
  'AMD',
  'NFLX',
  'AVGO',
] as const;
