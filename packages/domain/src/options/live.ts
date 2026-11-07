import { addDays } from '../market/calendar';
import { daysBetween } from './chain';
import type { DeriveRow, ExpiryValues } from './derive';
import { DAYS_PER_YEAR } from './pricing';
import type { OptionSignalValues } from './signals';

/**
 * The live chain for Research › Options (options data brief v2 §7, §10 item
 * 8, ADR 0048). On request the worker fetches one underlying's delayed
 * chain, works out IV, delta and gamma itself and keeps this view for 15
 * minutes. The view holds only the app's computed values plus open interest
 * and volume per strike: never a bid, an ask, a last price or a greek as the
 * source reported it (brief §8).
 */

/** A view this recent is shown again instead of fetching the chain (brief §10 item 8). */
export const LIVE_CHAIN_CACHE_MINUTES = 15;
/** Strikes further than this from the underlying are left out of the view (not out of the figures). */
export const LIVE_CHAIN_STRIKE_RANGE = 0.3;
/** Expiries further out than this are left out of the view. */
export const LIVE_CHAIN_MAX_DAYS = 400;
/** The expected-move cone runs this many calendar days ahead. */
export const CONE_MAX_DAYS = 60;

export interface LiveChainSide {
  /** The app's computed values; null when the contract had no usable quote. */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  openInterest: number | null;
  volume: number | null;
}

export interface LiveChainStrike {
  strike: number;
  call: LiveChainSide | null;
  put: LiveChainSide | null;
  /** Dollar gamma per 1% move at this strike: calls, puts and calls − puts (brief §4.8). */
  callGex: number | null;
  putGex: number | null;
}

export interface LiveChainExpiry extends ExpiryValues {
  /** The strike nearest the forward. */
  atmStrike: number | null;
  strikes: LiveChainStrike[];
}

export interface LiveChainView {
  symbol: string;
  /** The chain file's own time (UTC ISO): what the screen names under the section. */
  chainTime: string;
  /** The New York date the chain is priced on. */
  asOfDate: string;
  /** The price the chain was priced against. */
  underlyingPrice: number;
  /** Where that price came from: the chain file, or the last daily close when the file has none. */
  priceSource: 'chain' | 'close';
  riskFreeRate: number;
  dividendYield: number;
  /** The figures row: the daily signal fields worked out on this chain. */
  values: OptionSignalValues;
  /** Prior days of recorded IV30 behind IV rank and percentile. */
  ivHistoryDays: number;
  expiries: LiveChainExpiry[];
  /** Gamma exposure per strike over every expiry in the view. */
  gexByStrike: { strike: number; callGex: number; putGex: number }[];
  /** Open interest per strike over every expiry in the view. */
  oiByStrike: { strike: number; callOi: number; putOi: number }[];
  /** Contracts in the file, and how many were left out as malformed. */
  contracts: number;
  skipped: number;
  /** Which feed the chain came from, named under the section. */
  feed: 'cboe';
}

const gexOf = (row: DeriveRow | undefined, S: number) =>
  row && row.gamma != null && row.openInterest != null && Number.isFinite(row.gamma)
    ? (row.gamma * row.openInterest * 100 * S * S) / 100
    : null;

const side = (row: DeriveRow | undefined): LiveChainSide | null =>
  row
    ? {
        iv: row.iv,
        delta: row.delta,
        gamma: row.gamma,
        openInterest: row.openInterest,
        volume: row.volume,
      }
    : null;

/**
 * Builds the stored view from a computed chain and its derived figures.
 * `rows` carry the app's computed IV, delta and gamma (never the source's).
 */
export function buildLiveChainView(input: {
  symbol: string;
  chainTime: string;
  asOfDate: string;
  S: number;
  priceSource: 'chain' | 'close';
  r: number;
  q: number;
  rows: readonly DeriveRow[];
  values: OptionSignalValues;
  ivHistoryDays: number;
  expiries: readonly ExpiryValues[];
  atmStrikes: ReadonlyMap<string, number | undefined>;
  skipped: number;
}): LiveChainView {
  const { S } = input;
  const lo = S * (1 - LIVE_CHAIN_STRIKE_RANGE);
  const hi = S * (1 + LIVE_CHAIN_STRIKE_RANGE);
  const byExpiry = new Map<string, DeriveRow[]>();
  for (const row of input.rows) {
    const days = daysBetween(input.asOfDate, row.expiry);
    if (days < 0 || days > LIVE_CHAIN_MAX_DAYS || row.strike < lo || row.strike > hi) continue;
    const list = byExpiry.get(row.expiry) ?? [];
    list.push(row);
    byExpiry.set(row.expiry, list);
  }
  const gex = new Map<number, { callGex: number; putGex: number }>();
  const oi = new Map<number, { callOi: number; putOi: number }>();
  const expiries: LiveChainExpiry[] = [];
  for (const e of input.expiries) {
    const rows = byExpiry.get(e.expiry);
    if (!rows) continue;
    const strikes = [...new Set(rows.map((x) => x.strike))].sort((a, b) => a - b);
    const out: LiveChainStrike[] = strikes.map((strike) => {
      const call = rows.find((x) => x.strike === strike && x.right === 'call');
      const put = rows.find((x) => x.strike === strike && x.right === 'put');
      const callGex = gexOf(call, S);
      const putGex = gexOf(put, S);
      const g = gex.get(strike) ?? { callGex: 0, putGex: 0 };
      g.callGex += callGex ?? 0;
      g.putGex += putGex ?? 0;
      gex.set(strike, g);
      const o = oi.get(strike) ?? { callOi: 0, putOi: 0 };
      o.callOi += call?.openInterest ?? 0;
      o.putOi += put?.openInterest ?? 0;
      oi.set(strike, o);
      return { strike, call: side(call), put: side(put), callGex, putGex };
    });
    expiries.push({ ...e, atmStrike: input.atmStrikes.get(e.expiry) ?? null, strikes: out });
  }
  const sortedKeys = <T>(m: Map<number, T>) => [...m.entries()].sort((a, b) => a[0] - b[0]);
  return {
    symbol: input.symbol,
    chainTime: input.chainTime,
    asOfDate: input.asOfDate,
    underlyingPrice: S,
    priceSource: input.priceSource,
    riskFreeRate: input.r,
    dividendYield: input.q,
    values: input.values,
    ivHistoryDays: input.ivHistoryDays,
    expiries,
    gexByStrike: sortedKeys(gex).map(([strike, g]) => ({ strike, ...g })),
    oiByStrike: sortedKeys(oi).map(([strike, o]) => ({ strike, ...o })),
    contracts: input.rows.length,
    skipped: input.skipped,
    feed: 'cboe',
  };
}

export interface ConePoint {
  /** Calendar date (YYYY-MM-DD). */
  date: string;
  days: number;
  /** The 1-standard-deviation band: S × (1 ± IV × √(days ÷ 365)). */
  upper: number;
  lower: number;
  iv: number;
}

/**
 * The expected-move cone on the price chart (brief §7): from the price, one
 * point per expiry up to 60 days out at that expiry's at-the-money IV, so the
 * cone follows the term structure. Starts at the price on the chain's day.
 */
export function expectedMoveCone(
  view: Pick<LiveChainView, 'asOfDate' | 'underlyingPrice' | 'expiries'>,
  maxDays = CONE_MAX_DAYS,
): ConePoint[] {
  const S = view.underlyingPrice;
  if (!(S > 0)) return [];
  const points: ConePoint[] = [];
  for (const e of view.expiries) {
    if (e.daysToExpiry <= 0 || e.daysToExpiry > maxDays) continue;
    if (e.atmIv == null || !(e.atmIv > 0)) continue;
    const move = e.atmIv * Math.sqrt(e.daysToExpiry / DAYS_PER_YEAR);
    points.push({
      date: addDays(view.asOfDate, e.daysToExpiry),
      days: e.daysToExpiry,
      upper: S * (1 + move),
      lower: S * (1 - move),
      iv: e.atmIv,
    });
  }
  if (points.length === 0) return [];
  const first = points[0] as ConePoint;
  return [{ date: view.asOfDate, days: 0, upper: S, lower: S, iv: first.iv }, ...points];
}
