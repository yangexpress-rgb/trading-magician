import {
  bsmDelta,
  bsmGamma,
  DAYS_PER_YEAR,
  forwardPrice,
  impliedVolatility,
  type OptionRight,
} from './pricing';

/**
 * Computed IV, delta and gamma for one day's chain (brief §4 preamble).
 *
 * - Only out-of-the-money options are solved for IV: puts below the forward,
 *   calls above it. That sidesteps early exercise on American contracts. The
 *   in-the-money option at the same strike takes the out-of-the-money one's
 *   IV, as put-call parity says it should, and its greeks follow from that.
 * - At the at-the-money strike (the one nearest the forward) both the call
 *   and the put are solved, each from its own price; a side without a price
 *   takes the other side's IV.
 * - A contract's price is whatever the caller trusts: the mid of a usable
 *   quote for a recorded snapshot, the day's closing trade for a rebuilt day.
 *   No price means no IV for that side.
 */

export interface PricedContract {
  /** YYYY-MM-DD. */
  expiry: string;
  strike: number;
  right: OptionRight;
  /** The price to solve from, or undefined when the contract has none usable. */
  price: number | undefined;
}

export interface ComputedGreeks {
  iv: number | undefined;
  delta: number | undefined;
  gamma: number | undefined;
}

export interface ChainMarket {
  /** The trading day the chain describes. */
  asOfDate: string;
  /** The underlying's close that day. */
  S: number;
  r: number;
  q: number;
}

/** Whole calendar days from one date to another (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

/** Years to an expiry, counted in calendar days ÷ 365. */
export function yearsTo(asOfDate: string, expiry: string): number {
  return daysBetween(asOfDate, expiry) / DAYS_PER_YEAR;
}

/** The strike nearest the forward price (the lower one on a tie). */
export function atmStrike(strikes: readonly number[], forward: number): number | undefined {
  let best: number | undefined;
  for (const k of strikes) {
    if (
      best === undefined ||
      Math.abs(k - forward) < Math.abs(best - forward) ||
      (Math.abs(k - forward) === Math.abs(best - forward) && k < best)
    )
      best = k;
  }
  return best;
}

const NONE: ComputedGreeks = { iv: undefined, delta: undefined, gamma: undefined };

/** Computed IV, delta and gamma for each contract, in the input's order. */
export function computeChain(market: ChainMarket, contracts: readonly PricedContract[]) {
  const out: ComputedGreeks[] = contracts.map(() => NONE);
  if (!(market.S > 0) || !Number.isFinite(market.r) || !Number.isFinite(market.q)) return out;
  const byExpiry = new Map<string, number[]>();
  contracts.forEach((c, i) => {
    const list = byExpiry.get(c.expiry) ?? [];
    list.push(i);
    byExpiry.set(c.expiry, list);
  });
  for (const [expiry, indexes] of byExpiry) {
    const T = yearsTo(market.asOfDate, expiry);
    if (!(T > 0)) continue;
    const base = { S: market.S, T, r: market.r, q: market.q };
    const F = forwardPrice(market.S, T, market.r, market.q);
    const strikes = [...new Set(indexes.map((i) => (contracts[i] as PricedContract).strike))];
    const atm = atmStrike(strikes, F);
    const at = new Map<string, number>();
    for (const i of indexes) {
      const c = contracts[i] as PricedContract;
      at.set(`${c.strike}|${c.right}`, i);
    }
    const solve = (strike: number, right: OptionRight) => {
      const i = at.get(`${strike}|${right}`);
      const price = i === undefined ? undefined : contracts[i]?.price;
      return price === undefined
        ? undefined
        : impliedVolatility(right, price, { ...base, K: strike });
    };
    for (const K of strikes) {
      let callIv: number | undefined;
      let putIv: number | undefined;
      if (K === atm) {
        callIv = solve(K, 'call');
        putIv = solve(K, 'put');
        callIv ??= putIv;
        putIv ??= callIv;
      } else {
        const otm: OptionRight = K < F ? 'put' : 'call';
        const iv = solve(K, otm);
        callIv = iv;
        putIv = iv;
      }
      for (const [right, iv] of [
        ['call', callIv],
        ['put', putIv],
      ] as const) {
        const i = at.get(`${K}|${right}`);
        if (i === undefined || iv === undefined) continue;
        const p = { ...base, K, sigma: iv };
        out[i] = { iv, delta: bsmDelta(right, p), gamma: bsmGamma(p) };
      }
    }
  }
  return out;
}
