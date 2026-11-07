import { daysBetween, atmStrike } from './chain';
import { DAYS_PER_YEAR, forwardPrice, midQuote, type OptionRight } from './pricing';
import {
  isMonthlyExpiry,
  IV_RANK_MIN_HISTORY,
  ivRankPercentile,
  OPTION_SIGNAL_FIELDS,
  type OptionSignalValues,
} from './signals';

/**
 * The derive step (options data brief v2 §4.1–§4.9): one day's computed chain
 * for one underlying in, the signal row and the per-expiry rows out. Every
 * IV here is the app's computed IV (the pricing package), never a source's
 * reported one; a computed IV of zero or none is missing. Missing inputs give
 * a missing value, never zero (principle 4).
 */

export interface DeriveRow {
  expiry: string;
  strike: number;
  right: OptionRight;
  bid: number | null;
  ask: number | null;
  volume: number | null;
  openInterest: number | null;
  /** The pricing package's IV, delta and gamma. */
  iv: number | null;
  delta: number | null;
  gamma: number | null;
}

export interface DeriveInput {
  asOfDate: string;
  /** The underlying's close that day; no signal is derived without it. */
  S: number;
  r: number;
  q: number;
  rows: readonly DeriveRow[];
  /** 20-day realised volatility of the underlying (the registry's volatility metric). */
  realizedVol20?: number | null | undefined;
  /** IV30 of the trading days before this one, at most a year's worth (§4.3). */
  priorIv30?: readonly number[] | undefined;
  /** Days of prior IV30 needed before rank and percentile are known; 120 in production. */
  minHistory?: number | undefined;
}

export interface ExpiryValues {
  expiry: string;
  daysToExpiry: number;
  atmIv: number | null;
  putIv25d: number | null;
  callIv25d: number | null;
  putVolume: number | null;
  callVolume: number | null;
  putOi: number | null;
  callOi: number | null;
}

export interface DeriveResult {
  values: OptionSignalValues;
  ivHistoryDays: number;
  expiries: ExpiryValues[];
  /** Rows left out of gamma exposure for want of a computed gamma or an open interest. */
  gexSkipped: number;
}

/** The nearest expiry has at least this many calendar days to go (§4). */
export const MIN_EXPIRY_DAYS = 2;
/** Term structure compares the nearest expiry at least this far out (§4.6). */
export const TERM_NEAR_MIN_DAYS = 7;
/** A 25-delta leg must have an absolute delta within this window (§4.5). */
export const DELTA_25_WINDOW = [0.15, 0.35] as const;

const okIv = (v: number | null | undefined): v is number =>
  v != null && Number.isFinite(v) && v > 0;

function sum(values: readonly (number | null)[]): number | null {
  let total = 0;
  let any = false;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    total += v;
    any = true;
  }
  return any ? total : null;
}

interface ExpiryGroup {
  expiry: string;
  days: number;
  rows: DeriveRow[];
  atm: number | undefined;
}

/**
 * Interpolates in total variance to `target` days between (t1, σ1) and
 * (t2, σ2): V = t1·σ1² + (t2·σ2² − t1·σ1²)·(target − t1)/(t2 − t1),
 * σ = √(V ÷ target).
 */
export function varianceInterpolate(
  t1: number,
  s1: number,
  t2: number,
  s2: number,
  target = 30,
): number | null {
  if (t2 === t1) return s1;
  const v = t1 * s1 * s1 + ((t2 * s2 * s2 - t1 * s1 * s1) * (target - t1)) / (t2 - t1);
  return v > 0 ? Math.sqrt(v / target) : null;
}

export function deriveSignals(input: DeriveInput): DeriveResult {
  const values = Object.fromEntries(
    OPTION_SIGNAL_FIELDS.map((f) => [f, null]),
  ) as OptionSignalValues;
  const { S, r, q } = input;
  const groups = new Map<string, ExpiryGroup>();
  for (const row of input.rows) {
    const days = daysBetween(input.asOfDate, row.expiry);
    if (days < 0) continue;
    const g = groups.get(row.expiry) ?? { expiry: row.expiry, days, rows: [], atm: undefined };
    g.rows.push(row);
    groups.set(row.expiry, g);
  }
  const sorted = [...groups.values()].sort((a, b) => a.days - b.days);
  for (const g of sorted) {
    const F = forwardPrice(S, g.days / DAYS_PER_YEAR, r, q);
    g.atm = atmStrike([...new Set(g.rows.map((x) => x.strike))], F);
  }
  const leg = (g: ExpiryGroup, strike: number | undefined, right: OptionRight) =>
    strike === undefined ? undefined : g.rows.find((x) => x.strike === strike && x.right === right);

  const atmIvOf = (g: ExpiryGroup): number | null => {
    const c = leg(g, g.atm, 'call')?.iv;
    const p = leg(g, g.atm, 'put')?.iv;
    if (okIv(c) && okIv(p)) return (c + p) / 2;
    if (okIv(c)) return c;
    if (okIv(p)) return p;
    return null;
  };
  const delta25 = (g: ExpiryGroup, right: OptionRight): number | null => {
    const target = right === 'put' ? -0.25 : 0.25;
    let best: DeriveRow | undefined;
    for (const x of g.rows) {
      if (x.right !== right || x.delta == null || !okIv(x.iv)) continue;
      if (!best || Math.abs(x.delta - target) < Math.abs((best.delta as number) - target)) best = x;
    }
    if (!best) return null;
    const d = Math.abs(best.delta as number);
    return d >= DELTA_25_WINDOW[0] && d <= DELTA_25_WINDOW[1] ? (best.iv as number) : null;
  };

  const expiries: ExpiryValues[] = sorted.map((g) => {
    const side = (right: OptionRight, pick: (x: DeriveRow) => number | null) =>
      sum(g.rows.filter((x) => x.right === right).map(pick));
    return {
      expiry: g.expiry,
      daysToExpiry: g.days,
      atmIv: atmIvOf(g),
      putIv25d: delta25(g, 'put'),
      callIv25d: delta25(g, 'call'),
      putVolume: side('put', (x) => x.volume),
      callVolume: side('call', (x) => x.volume),
      putOi: side('put', (x) => x.openInterest),
      callOi: side('call', (x) => x.openInterest),
    };
  });
  const byExpiry = new Map(expiries.map((e) => [e.expiry, e]));

  const eligible = sorted.filter((g) => g.days >= MIN_EXPIRY_DAYS);
  const nearest = eligible[0] ?? sorted[0];

  // §4.2 IV30: the expiries either side of 30 days, both at least 2 days out.
  const interpolate30 = (pick: (e: ExpiryValues) => number | null): number | null => {
    const withValue = eligible
      .map((g) => ({ days: g.days, v: pick(byExpiry.get(g.expiry) as ExpiryValues) }))
      .filter((x): x is { days: number; v: number } => okIv(x.v));
    const below = withValue.filter((x) => x.days <= 30).at(-1);
    const above = withValue.find((x) => x.days > 30);
    if (below && below.days === 30) return below.v;
    if (below && above) return varianceInterpolate(below.days, below.v, above.days, above.v);
    const n = nearest ? pick(byExpiry.get(nearest.expiry) as ExpiryValues) : null;
    return okIv(n) ? n : null;
  };
  const iv30 = S > 0 ? interpolate30((e) => e.atmIv) : null;
  values.iv30 = iv30;
  values.atm_iv = nearest && S > 0 ? (byExpiry.get(nearest.expiry)?.atmIv ?? null) : null;

  // §4.1 expected moves.
  if (iv30 != null && S > 0) {
    for (const [n, pct, usd] of [
      [1, 'expected_move_1d_pct', 'expected_move_1d_usd'],
      [5, 'expected_move_5d_pct', 'expected_move_5d_usd'],
    ] as const) {
      const move = iv30 * Math.sqrt(n / DAYS_PER_YEAR);
      values[pct] = move;
      values[usd] = S * move;
    }
  }
  if (nearest && S > 0) {
    const call = leg(nearest, nearest.atm, 'call');
    const put = leg(nearest, nearest.atm, 'put');
    const legMid = (x: DeriveRow | undefined) =>
      x && x.bid !== null && x.ask !== null && x.ask >= x.bid ? midQuote(x.bid, x.ask) : undefined;
    const cm = legMid(call);
    const pm = legMid(put);
    if (cm !== undefined && pm !== undefined) values.straddle_move_pct = (cm + pm) / S;
  }

  // §4.3 rank and percentile.
  const rank = ivRankPercentile(
    iv30,
    input.priorIv30 ?? [],
    input.minHistory ?? IV_RANK_MIN_HISTORY,
  );
  values.iv_rank_252d = rank.rank;
  values.iv_percentile_252d = rank.percentile;

  // §4.4 IV / realised volatility.
  const rv = input.realizedVol20;
  if (iv30 != null && rv != null && rv > 0) values.iv_rv_ratio = iv30 / rv;

  // §4.5 skew: each 25-delta leg interpolated to 30 days, then put − call.
  const putSkew = S > 0 ? interpolate30((e) => e.putIv25d) : null;
  const callSkew = S > 0 ? interpolate30((e) => e.callIv25d) : null;
  if (putSkew != null && callSkew != null) values.skew_30d = putSkew - callSkew;

  // §4.6 term structure.
  const near7 = sorted.find((g) => g.days >= TERM_NEAR_MIN_DAYS);
  const near7Iv = near7 ? byExpiry.get(near7.expiry)?.atmIv : null;
  if (okIv(near7Iv) && iv30 != null) values.term_structure = near7Iv / iv30;

  // §4.7 put/call ratios at the nearest expiry.
  if (nearest) {
    const e = byExpiry.get(nearest.expiry) as ExpiryValues;
    if (e.putVolume != null && e.callVolume != null && e.callVolume > 0)
      values.put_call_volume = e.putVolume / e.callVolume;
    if (e.putOi != null && e.callOi != null && e.callOi > 0)
      values.put_call_oi = e.putOi / e.callOi;
  }

  // §4.8 gamma exposure over every expiry and strike.
  let callNotional = 0;
  let putNotional = 0;
  let totalOi = 0;
  let gexSkipped = 0;
  for (const g of sorted) {
    for (const x of g.rows) {
      if (x.openInterest != null && x.openInterest > 0) totalOi += x.openInterest;
      if (x.gamma == null || !Number.isFinite(x.gamma) || x.openInterest == null) {
        gexSkipped++;
        continue;
      }
      const notional = x.gamma * x.openInterest * 100;
      if (x.right === 'call') callNotional += notional;
      else putNotional += notional;
    }
  }
  if (totalOi > 0 && S > 0) {
    values.call_gex = (callNotional * S * S) / 100;
    values.put_gex = (putNotional * S * S) / 100;
    values.net_gex = values.call_gex - values.put_gex;
  }

  // §4.9 open-interest levels at the nearest monthly expiry.
  const monthlies = sorted.filter((g) => isMonthlyExpiry(g.expiry));
  const monthly = monthlies.find((g) => g.days >= MIN_EXPIRY_DAYS) ?? monthlies[0];
  if (monthly && S > 0) Object.assign(values, oiLevels(monthly.rows, S));

  return { values, ivHistoryDays: rank.days, expiries, gexSkipped };
}

/** Call wall, put wall and max pain for one expiry's rows (§4.9). */
export function oiLevels(rows: readonly DeriveRow[], S: number) {
  let callWall: DeriveRow | undefined;
  let putWall: DeriveRow | undefined;
  for (const x of rows) {
    const oi = x.openInterest;
    if (oi == null || oi <= 0) continue;
    if (x.right === 'call' && x.strike > S && (!callWall || oi > (callWall.openInterest ?? 0)))
      callWall = x;
    if (x.right === 'put' && x.strike < S && (!putWall || oi > (putWall.openInterest ?? 0)))
      putWall = x;
  }
  const strikes = [...new Set(rows.map((x) => x.strike))].sort((a, b) => a - b);
  let maxPain: number | null = null;
  let least = Number.POSITIVE_INFINITY;
  let anyOi = false;
  for (const P of strikes) {
    let pain = 0;
    for (const x of rows) {
      if (x.openInterest == null || x.openInterest <= 0) continue;
      anyOi = true;
      const intrinsic = x.right === 'call' ? Math.max(0, P - x.strike) : Math.max(0, x.strike - P);
      pain += intrinsic * x.openInterest;
    }
    if (pain < least) {
      least = pain;
      maxPain = P;
    }
  }
  return {
    call_wall: callWall?.strike ?? null,
    put_wall: putWall?.strike ?? null,
    max_pain: anyOi ? maxPain : null,
  };
}
