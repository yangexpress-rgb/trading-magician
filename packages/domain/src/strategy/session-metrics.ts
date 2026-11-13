import Decimal from 'decimal.js';
import type { Bar } from '../market/bars';
import { nyDate, regularSession } from '../market/calendar';

/**
 * Session-anchored values (intraday pack brief §§2–4, N253, ADR 0090): the
 * cumulative session VWAP, the session high and low so far, and the
 * opening-range high and low. They are worked out when a condition is
 * evaluated, from the instrument's intraday bars the run already loads; no
 * series is persisted and no bars are added to a run's plan.
 *
 * A session is the NYSE regular session of a trading date (09:30 to 16:00,
 * or 13:00 on early-close days), whatever the strategy's market hours policy.
 */

/** Today's completed regular-session bars as of one evaluation, oldest first. */
export interface SessionBars {
  /** The session's trading date, `YYYY-MM-DD`. */
  date: string;
  /** Session open and close, epoch ms. */
  open: number;
  close: number;
  /** Bars of this session whose end is at or before the current bar's end. */
  bars: readonly Bar[];
}

/**
 * The completed bars of the session that the bar at `index` belongs to, up to
 * and including that bar: never a later bar, never one from another session,
 * and never one outside the regular session's hours (so nothing after 13:00
 * counts on an early-close day). Undefined before the bar or off the calendar.
 */
export function sessionBarsAt(bars: readonly Bar[], index: number): SessionBars | undefined {
  const current = bars[index];
  if (!current) return undefined;
  const date = nyDate(current.start);
  const session = regularSession(date);
  if (!session) return undefined;
  const open = Date.parse(session.open);
  const close = Date.parse(session.close);
  const out: Bar[] = [];
  for (let i = index; i >= 0; i--) {
    const b = bars[i] as Bar;
    // Bars are in time order: one starting before today's open is from before the session.
    if (Date.parse(b.start) < open) break;
    if (Date.parse(b.end) <= close) out.push(b);
  }
  out.reverse();
  return { date, open, close, bars: out };
}

export const SESSION_METRIC_IDS = [
  'session.vwap',
  'session.high',
  'session.low',
  'session.opening_high',
  'session.opening_low',
] as const;
export type SessionMetricId = (typeof SESSION_METRIC_IDS)[number];

/** The opening-range length a new value starts with, in minutes from the open. */
export const DEFAULT_RANGE_MINUTES = 30;
/** Preset opening-range lengths the builder offers; any positive whole number is allowed. */
export const RANGE_MINUTE_PRESETS = [5, 15, 30, 60] as const;
/** The longest opening range: a full regular session. */
export const MAX_RANGE_MINUTES = 390;

const THREE = new Decimal(3);

/** A session value from today's bars so far; undefined when unknown (§3). */
export function sessionValue(
  id: SessionMetricId,
  s: SessionBars | undefined,
  rangeMinutes = DEFAULT_RANGE_MINUTES,
): Decimal | undefined {
  if (!s || s.bars.length === 0) return undefined;
  switch (id) {
    case 'session.vwap': {
      let pv = new Decimal(0);
      let volume = new Decimal(0);
      for (const b of s.bars) {
        pv = pv.plus(b.high.plus(b.low).plus(b.close).div(THREE).times(b.volume));
        volume = volume.plus(b.volume);
      }
      return volume.isZero() ? undefined : pv.div(volume);
    }
    case 'session.high':
      return Decimal.max(...s.bars.map((b) => b.high));
    case 'session.low':
      return Decimal.min(...s.bars.map((b) => b.low));
    case 'session.opening_high':
    case 'session.opening_low': {
      // Window bars start before open + rangeMinutes; only completed ones count (§4).
      const end = s.open + rangeMinutes * 60_000;
      const window = s.bars.filter((b) => Date.parse(b.start) < end);
      if (window.length === 0) return undefined;
      return id === 'session.opening_high'
        ? Decimal.max(...window.map((b) => b.high))
        : Decimal.min(...window.map((b) => b.low));
    }
  }
}

export function isSessionMetricId(id: string): id is SessionMetricId {
  return (SESSION_METRIC_IDS as readonly string[]).includes(id);
}
