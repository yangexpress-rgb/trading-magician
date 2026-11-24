import { SP500_HISTORY_PERIODS, SP500_HISTORY_THROUGH } from './groups/sp500-history';
import { stockGroup, type StockGroupId } from './stock-groups';

/**
 * Point-in-time index membership (data inputs part 2, item C, N324, ADR 0112).
 * A member's period runs from `from` until the day before `to`; `to` is null
 * while it is still a member. Back tests of the S&P 500 group and the pattern
 * factor store's universe read members as of each day; the screener, paper and
 * live runs and the ML trainer keep today's list (v1).
 */

export interface MembershipSpan {
  /** `YYYY-MM-DD`, the first day as a member. */
  from: string;
  /** `YYYY-MM-DD`, the first day no longer a member; null while still one. */
  to: string | null;
}

export interface MembershipPeriod extends MembershipSpan {
  symbol: string;
}

/** The groups with a point-in-time history; others read today's list. */
export const POINT_IN_TIME_GROUPS = ['sp500'] as const;
export type PointInTimeGroupId = (typeof POINT_IN_TIME_GROUPS)[number];

export const isPointInTimeGroup = (id: string): id is PointInTimeGroupId =>
  (POINT_IN_TIME_GROUPS as readonly string[]).includes(id);

export const SP500_PERIODS: readonly MembershipPeriod[] = SP500_HISTORY_PERIODS.map(
  ([symbol, from, to]) => ({ symbol, from, to }),
);

/** The last day the imported file describes; later changes arrive with the next import. */
export const SP500_PERIODS_THROUGH = SP500_HISTORY_THROUGH;

/**
 * How current a group's member data is, as a back test or pattern scan reads
 * it (O207): the imported history's last day for a point-in-time group, else
 * the day today's list was last refreshed ('' before its first refresh).
 */
export function groupMembersAsOf(id: StockGroupId): { asOf: string; pointInTime: boolean } {
  return isPointInTimeGroup(id)
    ? { asOf: SP500_PERIODS_THROUGH, pointInTime: true }
    : { asOf: stockGroup(id).asOf, pointInTime: false };
}

/** Whether a span covers `date`. */
export const spanCovers = (s: MembershipSpan, date: string) =>
  s.from <= date && (s.to === null || date < s.to);

/** Whether any span overlaps the days `from`..`to` (both included). */
export const spanOverlaps = (s: MembershipSpan, from: string, to: string) =>
  s.from <= to && (s.to === null || s.to > from);

/** The symbols that were members on `date`, sorted. */
export function membersOn(periods: readonly MembershipPeriod[], date: string): string[] {
  return [...new Set(periods.filter((p) => spanCovers(p, date)).map((p) => p.symbol))].sort();
}

/**
 * Ticker changes of one company inside the file, each a same-day swap there
 * (FB out, META in on 2022-06-09). A period under the old symbol resolves to
 * the instrument under the newest one, so one company is one instrument.
 * Mergers that made a new company (MYL to VTRS, WRK to SW, PARA to PSKY) are
 * not renames and stay apart.
 */
export const SYMBOL_RENAMES: readonly { from: string; to: string; on: string }[] = [
  { from: 'HRS', to: 'LHX', on: '2019-06-01' },
  { from: 'DWDP', to: 'DD', on: '2019-06-03' },
  { from: 'TMK', to: 'GL', on: '2019-08-08' },
  { from: 'BHGE', to: 'BKR', on: '2019-10-18' },
  { from: 'SYMC', to: 'NLOK', on: '2019-11-05' },
  { from: 'HCP', to: 'PEAK', on: '2019-11-05' },
  { from: 'CBS', to: 'VIAC', on: '2019-12-05' },
  { from: 'BBT', to: 'TFC', on: '2019-12-09' },
  { from: 'JEC', to: 'J', on: '2019-12-10' },
  { from: 'UTX', to: 'RTX', on: '2020-04-03' },
  { from: 'CTL', to: 'LUMN', on: '2020-09-18' },
  { from: 'LB', to: 'BBWI', on: '2021-08-03' },
  { from: 'COG', to: 'CTRA', on: '2021-10-04' },
  { from: 'WLTW', to: 'WTW', on: '2022-01-10' },
  { from: 'VIAC', to: 'PARA', on: '2022-02-17' },
  { from: 'BLL', to: 'BALL', on: '2022-05-10' },
  { from: 'FB', to: 'META', on: '2022-06-09' },
  { from: 'ANTM', to: 'ELV', on: '2022-06-28' },
  { from: 'NLOK', to: 'GEN', on: '2022-11-08' },
  { from: 'PKI', to: 'RVTY', on: '2023-05-16' },
  { from: 'FISV', to: 'FI', on: '2023-06-07' },
  { from: 'RE', to: 'EG', on: '2023-07-10' },
  { from: 'ABC', to: 'COR', on: '2023-08-30' },
  { from: 'CDAY', to: 'DAY', on: '2024-02-01' },
  { from: 'PEAK', to: 'DOC', on: '2024-03-04' },
  { from: 'FLT', to: 'CPAY', on: '2024-03-25' },
  { from: 'FI', to: 'FISV', on: '2025-11-11' },
  { from: 'MMC', to: 'MRSH', on: '2026-01-14' },
  { from: 'BK', to: 'BNY', on: '2026-05-21' },
];

/**
 * Symbols reused by a different company: a period under the symbol that ended
 * on or before `until` is another company's, so it never resolves to today's
 * instrument (old DuPont and Dow Chemical before the 2017 merger).
 */
export const REUSED_SYMBOLS: readonly { symbol: string; until: string }[] = [
  { symbol: 'DD', until: '2017-09-01' },
  { symbol: 'DOW', until: '2017-09-01' },
];

/**
 * The symbol a period's company trades under now, following renames from the
 * period's own symbol; undefined when the symbol then belonged to another
 * company than today's holder of it.
 */
export function currentSymbolFor(period: MembershipPeriod): string | undefined {
  if (
    REUSED_SYMBOLS.some(
      (r) => r.symbol === period.symbol && period.to !== null && period.to <= r.until,
    )
  )
    return undefined;
  let symbol = period.symbol;
  let since = period.from;
  for (;;) {
    const next = SYMBOL_RENAMES.find((r) => r.from === symbol && r.on >= since);
    if (!next) return symbol;
    symbol = next.to;
    since = next.on;
  }
}
export { SP500_HISTORY_SOURCE } from './groups/sp500-history';
