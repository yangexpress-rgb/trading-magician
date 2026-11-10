import { addDays, isTradingDay, nextTradingDay, nyDate, regularSession } from '../market/calendar';
import type { BarInterval } from './catalog';
import type { ExitRule, ScheduleFrequency, StrategyDefinition } from './schema';
import { definitionExpressions } from './selection';

/**
 * Calendar scheduling and holding-period exits (Design v1.2 item 4). Both the
 * back tester and the paper runtime call these with the bar time they are
 * evaluating, so a schedule means the same thing in both. Days are NYSE
 * trading days from the exchange calendar the rest of the app uses.
 *
 * Check Entry gates Entry and re-selection. Check Exit (ADR 0073) gates the
 * Exit condition and exit rules; a strategy without one checks them on every
 * bar, as before schema 3.
 *
 * N184 (ADR 0067): the bar cadences name their bar size (every 1-minute,
 * 5-minute or hourly bar), and "daily" means once a day after the close,
 * whatever bars the run steps on.
 */

export const SCHEDULE_LABELS: Record<ScheduleFrequency, string> = {
  bar1m: 'Every 1-minute bar',
  bar5m: 'Every 5-minute bar',
  bar1h: 'Every hourly bar',
  daily: 'Once a day, after the close',
  weekly: 'Last trading day of each week',
  monthEnd: 'Last trading day of each month',
  quarterEnd: 'Last trading day of each quarter',
  yearEnd: 'Last trading day of each year',
};

/** Minutes per bar of the bar cadences. */
export const SCHEDULE_BAR_MINUTES: Partial<Record<ScheduleFrequency, number>> = {
  bar1m: 1,
  bar5m: 5,
  bar1h: 60,
};

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

/** Whether the schedule is a calendar period (a rebalance date) rather than a bar cadence. */
export function isCalendarSchedule(frequency: ScheduleFrequency): boolean {
  return (
    frequency === 'weekly' ||
    frequency === 'monthEnd' ||
    frequency === 'quarterEnd' ||
    frequency === 'yearEnd'
  );
}

/**
 * The schedule of a strategy that never picked one (N184): the cadence of the
 * finest bars its rules read, so a stored strategy keeps checking Entry as
 * often as before. Minute bars under 5 minutes: every 1-minute bar; under an
 * hour: every 5-minute bar; under a day: every hourly bar; else once a day.
 */
export function defaultSchedule(def: StrategyDefinition): ScheduleFrequency {
  let finest = INTERVAL_MINUTES['1d'];
  for (const e of definitionExpressions(def)) {
    if (e.kind === 'market' || e.kind === 'indicator')
      finest = Math.min(finest, INTERVAL_MINUTES[e.interval]);
  }
  return finest < 5 ? 'bar1m' : finest < 60 ? 'bar5m' : finest < 1440 ? 'bar1h' : 'daily';
}

/** When Entry (and a group's filter and ranking) is checked: Check Entry. */
export function scheduleOf(def: StrategyDefinition): ScheduleFrequency {
  return def.entry.schedule?.frequency ?? defaultSchedule(def);
}

/**
 * When the Exit condition and exit rules are checked: Check Exit (ADR 0073).
 * Undefined means on every bar the run steps on, as before schema 3.
 */
export function exitScheduleOf(def: StrategyDefinition): ScheduleFrequency | undefined {
  return def.exit.schedule?.frequency;
}

/**
 * The Check Exit a new choice of Check Entry suggests (O145): the same, except
 * that a calendar Entry checks Exit once a day, so a rebalance on month end
 * still has daily risk exits.
 */
export function suggestedExitSchedule(entry: ScheduleFrequency): ScheduleFrequency {
  return isCalendarSchedule(entry) ? 'daily' : entry;
}

/** Monday of the ISO week a date falls in. */
function weekStart(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** The calendar period a trading day belongs to, e.g. "2026-03" for month end. */
export function periodKey(frequency: ScheduleFrequency, day: string): string {
  switch (frequency) {
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

/** Whether a day is the last trading day of its period. */
export function isPeriodEnd(frequency: ScheduleFrequency, day: string): boolean {
  if (!isTradingDay(day)) return false;
  if (!isCalendarSchedule(frequency)) return true;
  return periodKey(frequency, nextTradingDay(day)) !== periodKey(frequency, day);
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

/**
 * Whether Entry and re-selection are evaluated at time `t`, and the period to
 * remember when they are (undefined when not). `lastPeriod` is the period last
 * evaluated, so each period is evaluated once however often the caller asks.
 *
 * - Bar cadences: once per bar slot of that size, keyed by `barTime` (the end
 *   of the newest bar, `t` by default). On coarser bars that is every bar; on
 *   finer bars, the first bar of each slot (the one ending on its boundary).
 * - Once a day: at the first evaluation after a session's close.
 * - Calendar periods: at the first evaluation after the close of the period's
 *   last trading day.
 */
export function scheduledPeriod(
  frequency: ScheduleFrequency,
  t: number,
  lastPeriod: string | undefined,
  barTime: number = t,
): string | undefined {
  const minutes = SCHEDULE_BAR_MINUTES[frequency];
  let key: string;
  if (minutes !== undefined) {
    key = `B${minutes}:${Math.floor(barTime / (minutes * 60_000))}`;
  } else {
    const day = lastClosedDay(t);
    if (!isPeriodEnd(frequency, day)) return undefined;
    key = periodKey(frequency, day);
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
