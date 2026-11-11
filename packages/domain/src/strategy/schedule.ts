import { addDays, isTradingDay, nextTradingDay, nyDate, regularSession } from '../market/calendar';
import type { BarInterval } from './catalog';
import {
  SCHEDULE_FREQUENCIES,
  SCHEDULE_TIMES,
  scheduleFrom,
  type ExitRule,
  type Schedule,
  type ScheduleBar,
  type ScheduleDays,
  type ScheduleFrequency,
  type ScheduleTime,
  type ScheduleWhich,
  type StrategyDefinition,
} from './schema';
import { definitionExpressions } from './selection';

/**
 * Check Entry and Check Exit (N184, ADR 0073, N227 / ADR 0078). Both the back
 * tester and the paper runtime call these with the bar time they are
 * evaluating, so a schedule means the same thing in both. Days are NYSE
 * trading days from the exchange calendar the rest of the app uses.
 *
 * A schedule is three choices: which bar (every, 1st, 2nd, last, before the
 * open), its size (1, 5, 30 minutes, an hour, a day) and the days (every
 * trading day, or the last of each week, month, quarter or year). A strategy
 * without a Check Exit checks Exit on every bar, as before schema 3.
 */

export const SCHEDULE_WHICH_LABELS: Record<ScheduleWhich, string> = {
  every: 'Every',
  first: '1st',
  second: '2nd',
  last: 'Last',
  beforeOpen: 'Before the open',
};

export const SCHEDULE_BAR_LABELS: Record<ScheduleBar, string> = {
  '1m': '1-minute bar',
  '5m': '5-minute bar',
  '30m': '30-minute bar',
  '1h': '1-hour bar',
  '1d': '1-day bar',
};

export const SCHEDULE_DAYS_LABELS: Record<ScheduleDays, string> = {
  daily: 'every trading day',
  weekly: 'last trading day of each week',
  monthEnd: 'last trading day of each month',
  quarterEnd: 'last trading day of each quarter',
  yearEnd: 'last trading day of each year',
};

/** Minutes per bar of each bar size. */
export const SCHEDULE_BAR_MINUTES: Record<ScheduleBar, number> = {
  '1m': 1,
  '5m': 5,
  '30m': 30,
  '1h': 60,
  '1d': 1440,
};

const intraday = (s: Schedule) => s.bar !== '1d';

/**
 * The same schedule in its plainest form, so equal checks compare equal:
 * on daily bars, every, 1st, 2nd and last are all "after the close".
 */
export function normalSchedule(s: Schedule): Schedule {
  if (!intraday(s) && s.which !== 'beforeOpen') return { ...s, which: 'every' };
  return s;
}

/**
 * A schedule in words: "Every 5-minute bar, every trading day", "1st 5-minute
 * bar, last trading day of each month", "After the close, every trading day",
 * "Before the open, last trading day of each week".
 */
export function scheduleLabel(schedule: Schedule): string {
  const s = normalSchedule(schedule);
  const days = SCHEDULE_DAYS_LABELS[s.days];
  if (s.which === 'beforeOpen') return `Before the open, ${days}`;
  if (!intraday(s)) return `After the close, ${days}`;
  return `${SCHEDULE_WHICH_LABELS[s.which]} ${SCHEDULE_BAR_LABELS[s.bar]}, ${days}`;
}

/**
 * The bar size, in minutes, a run must step on for a schedule to be checked
 * on time: an intraday "every" bar's own, or the end of the 1st or 2nd bar
 * after the open. Undefined for checks at the close or before the open.
 */
export function scheduleBarMinutes(schedule: Schedule | undefined): number | undefined {
  if (!schedule || !intraday(schedule)) return undefined;
  const m = SCHEDULE_BAR_MINUTES[schedule.bar];
  if (schedule.which === 'every') return m;
  if (schedule.which === 'first') return m;
  if (schedule.which === 'second') return 2 * m;
  return undefined;
}

/** Whether checks are limited to the last trading day of a week, month, quarter or year (a rebalance date). */
export function isCalendarSchedule(schedule: Schedule): boolean {
  return schedule.days !== 'daily';
}

/** Whether the schedule checks every bar of an intraday size. */
export function isBarCadence(schedule: Schedule): boolean {
  return schedule.which === 'every' && intraday(schedule);
}

const INTERVAL_MINUTES: Record<BarInterval, number> = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240,
  '1d': 1440,
  '1w': 10_080,
};

/**
 * The schedule of a strategy that never picked one (N184): every bar of the
 * finest bars its rules read, so a stored strategy keeps checking Entry as
 * often as before. Under 5 minutes: every 1-minute bar; under an hour: every
 * 5-minute bar; under a day: every hourly bar; else once a day after the close.
 */
export function defaultSchedule(def: StrategyDefinition): Schedule {
  let finest = INTERVAL_MINUTES['1d'];
  for (const e of definitionExpressions(def)) {
    if (e.kind === 'market' || e.kind === 'indicator')
      finest = Math.min(finest, INTERVAL_MINUTES[e.interval]);
  }
  const bar: ScheduleBar = finest < 5 ? '1m' : finest < 60 ? '5m' : finest < 1440 ? '1h' : '1d';
  return { which: 'every', bar, days: 'daily' };
}

/** When Entry (and a group's filter and ranking) is checked: Check Entry. */
export function scheduleOf(def: StrategyDefinition): Schedule {
  return def.entry.schedule ?? defaultSchedule(def);
}

/**
 * When the Exit condition and exit rules are checked: Check Exit (ADR 0073).
 * Undefined means on every bar the run steps on, as before schema 3.
 */
export function exitScheduleOf(def: StrategyDefinition): Schedule | undefined {
  return def.exit.schedule;
}

/**
 * The Check Exit a new choice of Check Entry suggests (O145): the same, except
 * that an Entry on calendar days checks Exit once a day after the close, so a
 * month-end rebalance still has daily risk exits.
 */
export function suggestedExitSchedule(entry: Schedule): Schedule {
  return isCalendarSchedule(entry) ? { which: 'every', bar: '1d', days: 'daily' } : entry;
}

/** Monday of the ISO week a date falls in. */
function weekStart(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** The calendar period a trading day belongs to, e.g. "2026-03" for month end. */
export function periodKey(days: ScheduleDays, day: string): string {
  switch (days) {
    case 'weekly':
      return `W${weekStart(day)}`;
    case 'monthEnd':
      return day.slice(0, 7);
    case 'quarterEnd':
      return `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
    case 'yearEnd':
      return day.slice(0, 4);
    default:
      return day;
  }
}

/** Whether a day is one the schedule checks on: a trading day, the last of its period. */
export function isPeriodEnd(days: ScheduleDays, day: string): boolean {
  if (!isTradingDay(day)) return false;
  if (days === 'daily') return true;
  return periodKey(days, nextTradingDay(day)) !== periodKey(days, day);
}

/** The latest trading day whose regular session had closed by `t` (epoch ms). */
export function lastClosedDay(t: number): string {
  let day = nyDate(new Date(t));
  const session = regularSession(day);
  if (session && t >= Date.parse(session.close)) return day;
  do day = addDays(day, -1);
  while (!isTradingDay(day));
  return day;
}

/** The trading day a bar ending at `barTime` belongs to: a bar ending at midnight is the day before's. */
const barDay = (barTime: number) => nyDate(new Date(barTime - 1));

export interface ScheduleOptions {
  /**
   * Before the open: check at the prior session's close instead of `bar`
   * minutes before the open. Back tests step only on regular-session bar ends,
   * so they check here; the data and the next fill (the open) are the same.
   */
  beforeOpenAtClose?: boolean;
}

/**
 * Whether the scheduled part is checked at time `t`, and the period to
 * remember when it is (undefined when not). `lastPeriod` is the period last
 * checked, so each is checked once however often the caller asks. `barTime`
 * is the end of the newest bar (`t` by default).
 *
 * - Every intraday bar: once per bar slot of that size, keyed by `barTime`, on
 *   the schedule's days. On coarser run bars that is every run bar.
 * - 1st / 2nd intraday bar: on each scheduled day, at the first check whose
 *   newest bar ends at least one or two bars after the open.
 * - Every 1-day bar, or the last bar: at the first check after the close of
 *   each scheduled day.
 * - Before the open: on each scheduled day, from one bar before its open (or
 *   at the prior close, see `beforeOpenAtClose`).
 */
export function scheduledPeriod(
  schedule: Schedule,
  t: number,
  lastPeriod: string | undefined,
  barTime: number = t,
  options: ScheduleOptions = {},
): string | undefined {
  const s = normalSchedule(schedule);
  const minutes = SCHEDULE_BAR_MINUTES[s.bar];
  let key: string;
  if (s.which === 'beforeOpen') {
    // The session about to open, or open now: the day after the last close.
    const day = nextTradingDay(lastClosedDay(t));
    const session = regularSession(day);
    if (!session || !isPeriodEnd(s.days, day)) return undefined;
    if (!options.beforeOpenAtClose) {
      const lead = Math.min(minutes, 60) * 60_000;
      if (t < Date.parse(session.open) - lead) return undefined;
    }
    key = `P${periodKey(s.days, day)}`;
  } else if (s.which === 'every' && intraday(s)) {
    if (s.days !== 'daily' && !isPeriodEnd(s.days, barDay(barTime))) return undefined;
    key = `B${minutes}:${Math.floor(barTime / (minutes * 60_000))}`;
  } else if ((s.which === 'first' || s.which === 'second') && intraday(s)) {
    const day = barDay(barTime);
    const session = regularSession(day);
    if (!session || !isPeriodEnd(s.days, day)) return undefined;
    const after = (s.which === 'second' ? 2 : 1) * minutes * 60_000;
    if (barTime < Date.parse(session.open) + after) return undefined;
    key = `O${periodKey(s.days, day)}`;
  } else {
    const day = lastClosedDay(t);
    if (!isPeriodEnd(s.days, day)) return undefined;
    key = periodKey(s.days, day);
  }
  return key === lastPeriod ? undefined : key;
}

/** Trading days a position has been held at bar time `t`, counting the day it opened. */
export function tradingDaysHeld(openedAt: number, t: number): number {
  const from = nyDate(new Date(openedAt));
  const to = lastClosedDay(t);
  if (to < from) return 0;
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (isTradingDay(d)) n++;
  return n;
}

export function timeStopOf(
  def: StrategyDefinition,
): Extract<ExitRule, { kind: 'timeStop' }> | undefined {
  return def.exit.rules?.find(
    (r): r is Extract<ExitRule, { kind: 'timeStop' }> => r.kind === 'timeStop',
  );
}

/**
 * Whether the time stop fires (v1.2 item 4): at a close, once the position
 * has been held `barsHeld` trading days, counting the day of its first Entry
 * fill. With daily bars and fills at the next open, a 5-day stop decided at
 * the fifth close exits at the sixth open: the position is held through
 * exactly five bars. Combined with the Exit condition by OR.
 */
export function timeStopReached(
  def: StrategyDefinition,
  openedAt: number | undefined,
  t: number,
): boolean {
  const rule = timeStopOf(def);
  if (!rule || openedAt === undefined) return false;
  return tradingDaysHeld(openedAt, t) >= rule.barsHeld;
}

/**
 * A back test's logged Check Entry or Check Exit in words. Runs since N227
 * log the words; earlier runs logged the saved code ("monthEnd") and, for a
 * check after the open, its time ("open5m").
 */
export function loggedScheduleText(logged: string, at?: string): string {
  if (!(SCHEDULE_FREQUENCIES as readonly string[]).includes(logged)) return logged;
  const time = (SCHEDULE_TIMES as readonly string[]).includes(at ?? '')
    ? (at as ScheduleTime)
    : undefined;
  return scheduleLabel(scheduleFrom(logged as ScheduleFrequency, time));
}
