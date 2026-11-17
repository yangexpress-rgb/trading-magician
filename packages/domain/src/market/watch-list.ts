import { nyDate, regularSession } from './calendar';

/**
 * Watch list (N292, ADR 0101): a person's groups of symbols with each one's
 * last price and change since the previous close, refreshed every few seconds
 * while the list is open.
 */

/** A watch list symbol: a US ticker, upper case, as the instrument table keeps it. */
export const WATCH_SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;

export const MAX_WATCH_GROUPS = 20;
export const MAX_WATCH_ITEMS = 100;
export const WATCH_GROUP_NAME_MAX = 40;

export function normalizeWatchSymbol(raw: string): string | undefined {
  const s = raw.trim().toUpperCase();
  return WATCH_SYMBOL.test(s) ? s : undefined;
}

export function normalizeWatchGroupName(raw: string): string | undefined {
  const s = raw.trim().replace(/\s+/g, ' ');
  return s.length >= 1 && s.length <= WATCH_GROUP_NAME_MAX ? s : undefined;
}

export interface WatchDefaultItem {
  symbol: string;
  displayName: string;
}

/**
 * The list a person starts with. Alpaca has no index quotes, so the large
 * indices are watched through the ETFs that track them (their Chg% moves with
 * the index); the VIX is the real index, from Cboe's daily history.
 */
export const WATCH_LIST_DEFAULTS: readonly { name: string; items: readonly WatchDefaultItem[] }[] =
  [
    {
      name: 'Indices',
      items: [
        { symbol: 'SPY', displayName: 'S&P 500 (SPDR S&P 500 ETF)' },
        { symbol: 'QQQ', displayName: 'Nasdaq 100 (Invesco QQQ ETF)' },
        { symbol: 'DIA', displayName: 'Dow Jones 30 (SPDR Dow Jones ETF)' },
        { symbol: 'IWM', displayName: 'Russell 2000 (iShares Russell 2000 ETF)' },
        { symbol: 'VIX', displayName: 'CBOE Volatility Index' },
      ],
    },
    {
      name: 'Stocks',
      items: [
        { symbol: 'AAPL', displayName: 'Apple Inc.' },
        { symbol: 'TSLA', displayName: 'Tesla, Inc.' },
        { symbol: 'NFLX', displayName: 'Netflix, Inc.' },
        { symbol: 'NKE', displayName: 'Nike, Inc.' },
      ],
    },
  ];

export interface WatchPrice {
  last: number;
  prevClose: number | null;
}

/** Chg and Chg% from the previous close; null without one. */
export function watchChange(p: WatchPrice): { change: number; changePct: number } | null {
  if (p.prevClose === null || !(p.prevClose > 0)) return null;
  const change = p.last - p.prevClose;
  return { change, changePct: (change / p.prevClose) * 100 };
}

/**
 * How often watched prices are asked for again: every few seconds while US
 * stocks trade (4 AM to 8 PM New York on a trading day, extended hours
 * included), once a minute otherwise, when nothing moves.
 */
export const WATCH_REFRESH = { activeMs: 5_000, quietMs: 60_000 } as const;

export function watchRefreshMs(at: Date): number {
  const session = regularSession(nyDate(at));
  if (!session) return WATCH_REFRESH.quietMs;
  const open = Date.parse(session.open);
  const close = Date.parse(session.close);
  const t = at.getTime();
  // Pre-market from 4:00 (5.5 hours before 9:30), after-hours to 20:00 (4 hours after 16:00).
  return t >= open - 5.5 * 3600_000 && t < close + 4 * 3600_000
    ? WATCH_REFRESH.activeMs
    : WATCH_REFRESH.quietMs;
}

/** A list is priced while someone opened it within this many seconds. */
export const WATCH_DEMAND_SECONDS = 30;
