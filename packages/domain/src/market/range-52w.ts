import { nextTradingDay } from './calendar';
import { YEAR_RANGE_SESSIONS } from '../strategy/metrics';

/**
 * Each stock's 52-week low and high, and how many trading days ago each was
 * set (N290). The worker works them out after every close from a year of
 * split-adjusted daily bars and stores them; the screener and Price charts
 * read the stored figures and roll them forward with today's live prices
 * while the market is open. Strategies compute the same figures from bars
 * through the metric registry (`from_52w_low`, `days_since_52w_low`, ...),
 * over the same 252 sessions.
 */

/** One session's split-adjusted prices. */
export interface RangeDay {
  /** New York date of the session. */
  date: string;
  high: number;
  low: number;
  close: number;
}

/** A low or a high: the price, the session that set it, and trading days since. */
export interface RangeExtreme {
  price: number;
  on: string;
  /** Trading days after `on` up to the as-of session: 0 when that session set it. */
  days: number;
}

/** The stored figures: the 52 weeks to `asOf`, and the 251 sessions to it (to roll forward a day). */
export interface YearRange {
  asOf: string;
  /** The as-of session's close. */
  close: number;
  low: RangeExtreme;
  high: RangeExtreme;
  /** The latest 251 sessions' low and high: with the next session's bar, the next 52 weeks. */
  tailLow: RangeExtreme;
  tailHigh: RangeExtreme;
}

function extreme(days: readonly RangeDay[], side: 'low' | 'high'): RangeExtreme {
  let at = days.length - 1;
  for (let i = days.length - 1; i >= 0; i--) {
    const d = days[i] as RangeDay;
    const best = days[at] as RangeDay;
    // Ties go to the latest session, so only a strictly better price moves it back.
    if (side === 'low' ? d.low < best.low : d.high > best.high) at = i;
  }
  const d = days[at] as RangeDay;
  return { price: side === 'low' ? d.low : d.high, on: d.date, days: days.length - 1 - at };
}

/**
 * The 52-week figures as of the latest session in `days` (oldest first, one
 * per session). Undefined without a full 252 sessions of prices, as the
 * strategy metrics are.
 */
export function yearRange(days: readonly RangeDay[]): YearRange | undefined {
  const usable = days.filter((d) => d.low > 0 && d.high > 0 && d.close > 0);
  if (usable.length < YEAR_RANGE_SESSIONS) return undefined;
  const window = usable.slice(-YEAR_RANGE_SESSIONS);
  const tail = window.slice(1);
  const last = window.at(-1) as RangeDay;
  return {
    asOf: last.date,
    close: last.close,
    low: extreme(window, 'low'),
    high: extreme(window, 'high'),
    tailLow: extreme(tail, 'low'),
    tailHigh: extreme(tail, 'high'),
  };
}

/** Today's session so far, from a screen or a quote. */
export interface RangeToday {
  date: string;
  low: number | null;
  high: number | null;
  last: number | null;
}

/** What a person sees: the low and high with days since, and the price against each. */
export interface YearRangeView {
  /** The session the figures are as of: today's while it trades, else the stored one. */
  asOf: string;
  low: RangeExtreme;
  high: RangeExtreme;
  /** The price the percentages use: today's last, or the stored close. */
  price: number;
  /** Percent above the 52-week low (0 or more). */
  fromLowPct: number;
  /** Percent from the 52-week high (0 or less). */
  fromHighPct: number;
}

const pct = (to: number, from: number) => Math.round((to / from - 1) * 10000) / 100;

/**
 * The stored figures, rolled forward a session with today's prices when
 * `today` is the session after the stored one: the oldest session leaves the
 * window and today's low or high counts. Figures two or more sessions old
 * stay as stored (with their own as-of date) until the worker's next pass.
 */
export function liveYearRange(stored: YearRange, today?: RangeToday | null): YearRangeView {
  const rolls =
    today != null &&
    today.date > stored.asOf &&
    nextTradingDay(stored.asOf) === today.date &&
    today.low != null &&
    today.high != null &&
    today.low > 0 &&
    today.high > 0;
  if (!rolls) {
    const price = stored.close;
    return {
      asOf: stored.asOf,
      low: stored.low,
      high: stored.high,
      price,
      fromLowPct: pct(price, stored.low.price),
      fromHighPct: pct(price, stored.high.price),
    };
  }
  const t = today as RangeToday & { low: number; high: number };
  const low: RangeExtreme =
    t.low <= stored.tailLow.price
      ? { price: t.low, on: t.date, days: 0 }
      : { ...stored.tailLow, days: stored.tailLow.days + 1 };
  const high: RangeExtreme =
    t.high >= stored.tailHigh.price
      ? { price: t.high, on: t.date, days: 0 }
      : { ...stored.tailHigh, days: stored.tailHigh.days + 1 };
  const price = t.last != null && t.last > 0 ? t.last : stored.close;
  return {
    asOf: t.date,
    low,
    high,
    price,
    fromLowPct: pct(price, low.price),
    fromHighPct: pct(price, high.price),
  };
}
