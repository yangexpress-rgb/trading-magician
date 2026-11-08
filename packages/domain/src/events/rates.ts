/**
 * Daily rates (free data feeds brief v1 §3, §5.4): FRED's 3-month Treasury
 * bill (DTB3), the risk-free rate the options computation already fetches,
 * stored so back tests can read it. Values are fractions: 0.0412 is 4.12%.
 */
export interface RatePoint {
  date: string;
  tbill3m: number;
}

/** The latest rate dated on or before `date`; `list` is sorted by date. */
export function rateOn(list: readonly RatePoint[] | undefined, date: string) {
  if (!list) return undefined;
  let lo = 0;
  let hi = list.length - 1;
  let found: RatePoint | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = list[mid] as RatePoint;
    if (p.date <= date) {
      found = p;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** The first day stored rates go back to, matching the options history (brief D5). */
export const EVENT_HISTORY_FROM = '2024-02-01';
