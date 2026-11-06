import { addDays, isTradingDay, nextTradingDay, nyDate, regularSession } from '../market/calendar';
import type { ExitRule, Schedule, ScheduleFrequency, StrategyDefinition } from './schema';

/**
 * Calendar scheduling and holding-period exits (Design v1.2 item 4). Both the
 * back tester and the paper runtime call these with the bar time they are
 * evaluating, so a schedule means the same thing in both. Days are NYSE
 * trading days from the exchange calendar the rest of the app uses.
 *
 * The schedule gates Entry and re-selection only. Exit conditions and exit
 * rules (the time stop, later the ATR stop) run on every bar, because a risk
 * exit must not wait for the next rebalance date.
 */

export const SCHEDULE_LABELS: Record<ScheduleFrequency, string> = {
  daily: 'Every bar (daily)',
  weekly: 'Last trading day of each week',
  monthEnd: 'Last trading day of each month',
  quarterEnd: 'Last trading day of each quarter',
  yearEnd: 'Last trading day of each year',
};

export function scheduleOf(def: Pick<StrategyDefinition, 'schedule'>): ScheduleFrequency {
  return def.schedule?.frequency ?? 'daily';
}

/** Monday of the ISO week a date falls in. */
function weekStart(day: string): string {
  const dow = new Date(`${day}T12:00:00Z`).getUTCDay();
  return addDays(day, -((dow + 6) % 7));
}

/** The period a trading day belongs to, e.g. "2026-03" for month end. */
export function periodKey(frequency: ScheduleFrequency, day: string): string {
  switch (frequency) {
    case 'daily':
      return day;
    case 'weekly':
      return `W${weekStart(day)}`;
    case 'monthEnd':
      return day.slice(0, 7);
    case 'quarterEnd':
      return `${day.slice(0, 4)}-Q${Math.ceil(Number(day.slice(5, 7)) / 3)}`;
    case 'yearEnd':
      return day.slice(0, 4);
  }
}

/** Whether a day is the last trading day of its period. */
export function isPeriodEnd(frequency: ScheduleFrequency, day: string): boolean {
  if (!isTradingDay(day)) return false;
  if (frequency === 'daily') return true;
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
 * Whether Entry and re-selection are evaluated at bar time `t`: on a daily
 * schedule always; otherwise once, at the first evaluation after the close
 * of the period's last trading day. `lastPeriod` is the period last
 * evaluated, so a runtime that passes several times after the close still
 * evaluates once. Returns the period to remember, or undefined.
 */
export function scheduledPeriod(
  schedule: Schedule | undefined,
  t: number,
  lastPeriod: string | undefined,
): string | undefined {
  const frequency = schedule?.frequency ?? 'daily';
  const day = lastClosedDay(t);
  if (frequency === 'daily') return day;
  if (!isPeriodEnd(frequency, day)) return undefined;
  const key = periodKey(frequency, day);
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

export function timeStopOf(def: StrategyDefinition): Extract<ExitRule, { kind: 'timeStop' }> | undefined {
  return def.exit.rules?.find((r): r is Extract<ExitRule, { kind: 'timeStop' }> => r.kind === 'timeStop');
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
