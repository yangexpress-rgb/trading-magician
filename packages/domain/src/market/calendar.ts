import { zonedWallTimeToIso } from '../time';

/**
 * NYSE trading calendar (holiday policy confirmed 2026-10-04). Rule-based, so
 * it needs no data file: the nine full-day holidays with weekend observance,
 * the three regular 1 p.m. early closes, and the special closures announced
 * since 2015. Dates are New York calendar dates, `YYYY-MM-DD`.
 */

export const NYSE_ZONE = 'America/New_York';
export const REGULAR_OPEN = '09:30';
export const REGULAR_CLOSE = '16:00';
export const EARLY_CLOSE = '13:00';

/** One-off closures (national days of mourning). */
const SPECIAL_CLOSURES: Readonly<Record<string, string>> = {
  '2018-12-05': 'National Day of Mourning (George H. W. Bush)',
  '2025-01-09': 'National Day of Mourning (Jimmy Carter)',
};

const pad = (n: number) => String(n).padStart(2, '0');
export const isoDate = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Day of week, 0 = Sunday, for a calendar date. */
export function weekday(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The nth (1-based) given weekday of a month, or the last one when n is -1. */
function nthWeekday(year: number, month: number, dow: number, n: number): string {
  if (n === -1) {
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    let date = isoDate(year, month, last);
    while (weekday(date) !== dow) date = addDays(date, -1);
    return date;
  }
  let date = isoDate(year, month, 1);
  while (weekday(date) !== dow) date = addDays(date, 1);
  return addDays(date, 7 * (n - 1));
}

/** Gregorian Easter Sunday (anonymous algorithm). */
function easter(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDate(year, month, day);
}

/** Saturday holidays move to Friday and Sunday holidays to Monday. */
function observed(date: string): string {
  const dow = weekday(date);
  if (dow === 6) return addDays(date, -1);
  if (dow === 0) return addDays(date, 1);
  return date;
}

const holidayCache = new Map<number, ReadonlyMap<string, string>>();

/** Full-day NYSE closures in a year, keyed by date. */
export function nyseHolidays(year: number): ReadonlyMap<string, string> {
  const cached = holidayCache.get(year);
  if (cached) return cached;
  const days = new Map<string, string>();
  // New Year's Day on a Saturday is not observed on the previous Friday.
  const newYear = isoDate(year, 1, 1);
  if (weekday(newYear) !== 6) days.set(observed(newYear), "New Year's Day");
  days.set(nthWeekday(year, 1, 1, 3), 'Martin Luther King Jr. Day');
  days.set(nthWeekday(year, 2, 1, 3), "Washington's Birthday");
  days.set(addDays(easter(year), -2), 'Good Friday');
  days.set(nthWeekday(year, 5, 1, -1), 'Memorial Day');
  if (year >= 2022) days.set(observed(isoDate(year, 6, 19)), 'Juneteenth');
  days.set(observed(isoDate(year, 7, 4)), 'Independence Day');
  days.set(nthWeekday(year, 9, 1, 1), 'Labor Day');
  days.set(nthWeekday(year, 11, 4, 4), 'Thanksgiving Day');
  days.set(observed(isoDate(year, 12, 25)), 'Christmas Day');
  for (const [date, name] of Object.entries(SPECIAL_CLOSURES)) {
    if (date.startsWith(`${year}-`)) days.set(date, name);
  }
  holidayCache.set(year, days);
  return days;
}

export function holidayName(date: string): string | undefined {
  return nyseHolidays(Number(date.slice(0, 4))).get(date);
}

export function isTradingDay(date: string): boolean {
  const dow = weekday(date);
  return dow !== 0 && dow !== 6 && holidayName(date) === undefined;
}

/** Whether the regular session ends at 1 p.m. (July 3, the day after Thanksgiving, December 24). */
export function isEarlyClose(date: string): boolean {
  if (!isTradingDay(date)) return false;
  const year = Number(date.slice(0, 4));
  const md = date.slice(5);
  const dow = weekday(date);
  if (md === '07-03' && dow >= 1 && dow <= 4) return true;
  if (md === '12-24' && dow >= 1 && dow <= 4) return true;
  return date === addDays(nthWeekday(year, 11, 4, 4), 1);
}

export interface TradingSession {
  date: string;
  /** Regular session open and close as UTC ISO instants. */
  open: string;
  close: string;
  earlyClose: boolean;
}

const sessionCache = new Map<string, TradingSession | undefined>();

/** The regular session on a date, or undefined when the market is closed. */
export function regularSession(date: string): TradingSession | undefined {
  if (sessionCache.has(date)) return sessionCache.get(date);
  const session = computeSession(date);
  sessionCache.set(date, session);
  return session;
}

function computeSession(date: string): TradingSession | undefined {
  if (!isTradingDay(date)) return undefined;
  const earlyClose = isEarlyClose(date);
  const open = zonedWallTimeToIso(`${date}T${REGULAR_OPEN}`, NYSE_ZONE);
  const close = zonedWallTimeToIso(
    `${date}T${earlyClose ? EARLY_CLOSE : REGULAR_CLOSE}`,
    NYSE_ZONE,
  );
  if (!open || !close) throw new Error(`No session times for ${date}`);
  return {
    date,
    open: new Date(open).toISOString(),
    close: new Date(close).toISOString(),
    earlyClose,
  };
}

/** Trading days from `from` to `to`, both inclusive. */
export function tradingDays(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if (isTradingDay(d)) days.push(d);
  return days;
}

export function nextTradingDay(date: string): string {
  let d = addDays(date, 1);
  while (!isTradingDay(d)) d = addDays(d, 1);
  return d;
}

const nyDateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: NYSE_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The New York calendar date of an instant. */
export function nyDate(instant: string | Date): string {
  return nyDateFormat.format(new Date(instant));
}
