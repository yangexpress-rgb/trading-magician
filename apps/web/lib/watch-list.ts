import { indexListingBySymbol, nyDate, regularSession, watchChange } from '@tm/domain';

/**
 * The watch list (N292, ADR 0101): groups of symbols, each with its last
 * price and change since the previous close, refreshed while the page is open.
 */

export interface WatchRowDto {
  id: string;
  symbol: string;
  displayName: string | null;
  instrumentId: string | null;
  /** An index, in points rather than dollars, such as the VIX. */
  isIndex: boolean;
  last: number | null;
  change: number | null;
  changePct: number | null;
  /** When the price was traded or published (ISO). */
  priceAt: string | null;
  /** A daily close rather than a live trade. */
  daily: boolean;
  /**
   * The latest pre-market or after-hours trade, measured from the regular
   * close shown in `last` (N298); null during the regular session.
   */
  ext: WatchExtDto | null;
}

export interface WatchExtDto {
  phase: 'pre' | 'post';
  last: number;
  change: number;
  changePct: number;
  priceAt: string;
}

export interface WatchGroupDto {
  id: string;
  name: string;
  collapsed: boolean;
  rows: WatchRowDto[];
}

export interface WatchListDto {
  groups: WatchGroupDto[];
  /** When the server answered (ISO). */
  asOf: string;
}

/** How often the open page asks for prices. */
export const WATCH_POLL_MS = 2_000;

interface GroupIn {
  id: string;
  name: string;
  collapsed: boolean;
  items: { id: string; symbol: string; instrumentId: string | null; displayName: string | null }[];
}
interface QuoteIn {
  symbol: string;
  last: number;
  prevClose: number | null;
  priceAt: string;
  daily: boolean;
  extLast?: number | null;
  extAt?: string | null;
}

/** Pre-market when traded before its day's open, else after hours. */
export function extPhase(at: string): 'pre' | 'post' {
  const session = regularSession(nyDate(at));
  return session && Date.parse(at) < Date.parse(session.open) ? 'pre' : 'post';
}

function extOf(q: QuoteIn): WatchExtDto | null {
  if (!q.extLast || !q.extAt || q.daily) return null;
  const c = watchChange({ last: q.extLast, prevClose: q.last });
  if (!c) return null;
  return { phase: extPhase(q.extAt), last: q.extLast, ...c, priceAt: q.extAt };
}

/**
 * A row as shown: with extended hours on, a pre-market or after-hours trade
 * takes the place of the regular session's price (N298).
 */
export function shownWatchRow(row: WatchRowDto, extended: boolean): WatchRowDto {
  if (!extended || !row.ext) return row;
  const { last, change, changePct, priceAt } = row.ext;
  return { ...row, last, change, changePct, priceAt };
}

export function buildWatchList(
  groups: readonly GroupIn[],
  quotes: readonly QuoteIn[],
  now: Date,
): WatchListDto {
  const bySymbol = new Map(quotes.map((q) => [q.symbol, q]));
  return {
    asOf: now.toISOString(),
    groups: groups.map((g) => ({
      id: g.id,
      name: g.name,
      collapsed: g.collapsed,
      rows: g.items.map((i) => {
        const q = bySymbol.get(i.symbol);
        const c = q ? watchChange(q) : null;
        const index = indexListingBySymbol(i.symbol);
        return {
          id: i.id,
          symbol: i.symbol,
          displayName: i.displayName ?? index?.displayName ?? null,
          instrumentId: i.instrumentId,
          isIndex: !!index,
          last: q?.last ?? null,
          change: c?.change ?? null,
          changePct: c?.changePct ?? null,
          priceAt: q?.priceAt ?? null,
          daily: q?.daily ?? false,
          ext: q ? extOf(q) : null,
        };
      }),
    })),
  };
}

const MINUS = '−';

function digits(value: number): number {
  const a = Math.abs(value);
  return a !== 0 && a < 1 ? 4 : 2;
}

function plain(value: number, places: number): string {
  return Math.abs(value).toLocaleString('en-US', {
    minimumFractionDigits: places,
    maximumFractionDigits: places,
  });
}

/** Last: "$351.95" for a stock or ETF, "25.26" for an index (points, not dollars). */
export function formatWatchLast(value: number | null, isIndex: boolean): string {
  if (value === null) return '—';
  return `${isIndex ? '' : '$'}${plain(value, digits(value))}`;
}

/** Chg: "+$2.35", "−$0.83", "$0.00"; an index's in points. */
export function formatWatchChange(
  value: number | null,
  isIndex: boolean,
  last?: number | null,
): string {
  if (value === null) return '—';
  const places = last !== undefined && last !== null ? digits(last) : digits(value);
  const body = `${isIndex ? '' : '$'}${plain(value, places)}`;
  const rounded = Number(value.toFixed(places));
  return rounded > 0 ? `+${body}` : rounded < 0 ? `${MINUS}${body}` : body;
}

/** Chg%: "+10.26%", "−1.13%", "0.00%". */
export function formatWatchPct(value: number | null): string {
  if (value === null) return '—';
  const body = `${plain(value, 2)}%`;
  const rounded = Number(value.toFixed(2));
  return rounded > 0 ? `+${body}` : rounded < 0 ? `${MINUS}${body}` : body;
}

/**
 * Where a new price's text first differs from the old one, so only the
 * digits that moved light up: "351.95" → "351.97" lights "7".
 */
export function changedFrom(before: string, after: string): number {
  let i = 0;
  while (i < before.length && i < after.length && before[i] === after[i]) i++;
  return i;
}

/** A steady colour for a symbol's badge, from its letters. */
export function symbolHue(symbol: string): number {
  let h = 0;
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return h;
}

export type WatchSortKey = 'symbol' | 'last' | 'change' | 'changePct';
export interface WatchSort {
  key: WatchSortKey;
  dir: 'asc' | 'desc';
}

/** Ascending, then descending, then back to the saved order. */
export function nextWatchSort(current: WatchSort | null, key: WatchSortKey): WatchSort | null {
  if (current?.key !== key) return { key, dir: 'asc' };
  return current.dir === 'asc' ? { key, dir: 'desc' } : null;
}

/** A section's rows in the chosen order; rows without a price always come last. */
export function sortWatchRows(rows: readonly WatchRowDto[], sort: WatchSort | null): WatchRowDto[] {
  if (!sort) return [...rows];
  const sign = sort.dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (sort.key === 'symbol') return sign * a.symbol.localeCompare(b.symbol);
    const x = a[sort.key];
    const y = b[sort.key];
    if (x === null && y === null) return 0;
    if (x === null) return 1;
    if (y === null) return -1;
    return sign * (x - y);
  });
}

/** Reads a remembered sort; anything else means the saved order. */
export function parseWatchSort(raw: string | null): WatchSort | null {
  if (!raw) return null;
  const [key, dir] = raw.split('.');
  return ['symbol', 'last', 'change', 'changePct'].includes(key ?? '') &&
    (dir === 'asc' || dir === 'desc')
    ? { key: key as WatchSortKey, dir }
    : null;
}
