import { nextTradingDay } from '../market/calendar';

/**
 * FINRA consolidated short interest (data inputs part 2, item B, N323, ADR
 * 0111): twice a month, per settlement date, the short position firms
 * reported for each exchange-listed and OTC equity. Read point in time by the
 * date it became public, never the date it describes.
 */

export interface ShortInterestPoint {
  settlementDate: string;
  /** The first day a bar may read the row (FINRA's publication date). */
  availableDate: string;
  shortShares: number;
  /** As FINRA published it: current minus the previous cycle's short position. */
  changeShares: number | null;
  /** The previous cycle's short position as FINRA published it (unadjusted). */
  previousShortShares: number | null;
  avgDailyVolume: number | null;
  daysToCover: number | null;
}

/**
 * FINRA's publication date for a settlement date: positions are due the
 * second business day after settlement and published five business days
 * after that, seven NYSE trading days in all. Checked against every date of
 * FINRA's published 2026–2027 schedule (test fixture).
 */
export function shortInterestPublicationDate(settlementDate: string): string {
  let d = settlementDate;
  for (let i = 0; i < 7; i++) d = nextTradingDay(d);
  return d;
}

/**
 * The latest row public on `barDate` (available on or before it). `list` is
 * sorted by settlement date, which also orders the publication dates.
 */
export function shortInterestOn(
  list: readonly ShortInterestPoint[] | undefined,
  barDate: string,
): ShortInterestPoint | undefined {
  if (!list) return undefined;
  let lo = 0;
  let hi = list.length - 1;
  let found: ShortInterestPoint | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = list[mid] as ShortInterestPoint;
    if (p.availableDate <= barDate) {
      found = p;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found;
}

/** Change in short shares vs the prior settlement ÷ prior, as a fraction; unknown when prior is 0 or absent. */
export function shortChangePct(p: ShortInterestPoint): number | undefined {
  if (p.changeShares === null || p.previousShortShares === null) return undefined;
  if (!(p.previousShortShares > 0)) return undefined;
  return p.changeShares / p.previousShortShares;
}

/**
 * Days to cover as published. FINRA writes 999.99 (and 0 volume) when the
 * average daily volume is zero: that is no value, so unknown here.
 */
export function shortDaysToCover(p: ShortInterestPoint): number | undefined {
  if (p.daysToCover === null || !(p.avgDailyVolume !== null && p.avgDailyVolume > 0))
    return undefined;
  return p.daysToCover;
}

/**
 * FINRA writes share classes without a separator (BRKB); the app writes
 * them with a dot (BRK.B). The key both resolve through.
 */
export const finraSymbolKey = (symbol: string) => symbol.toUpperCase().replace(/[./\s-]/g, '');
