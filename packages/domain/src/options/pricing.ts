/**
 * The options pricing package (options data brief v2 §4 preamble, ADR 0047):
 * Black-Scholes-Merton with a continuous dividend yield, its delta and gamma,
 * and an implied-volatility solver. The app works out IV, delta and gamma
 * itself from each contract's price instead of trusting a source's figures,
 * so live, recorded and rebuilt values all come from one method.
 *
 * Plain numbers (doubles), not Decimal: the model is transcendental and its
 * inputs are quotes with two decimals. Time is in years (calendar days ÷ 365),
 * rates and yields are continuously compounded fractions.
 */

export type OptionRight = 'call' | 'put';

/** Days in the year time to expiry is counted in (calendar days). */
export const DAYS_PER_YEAR = 365;

/**
 * The standard normal cumulative distribution, by Hart's double-precision
 * algorithm (G. West, "Better approximations to cumulative normal functions",
 * 2005), accurate to about 1e-14 everywhere.
 */
export function normCdf(x: number): number {
  const a = Math.abs(x);
  let tail: number;
  if (a > 37) tail = 0;
  else {
    const e = Math.exp((-a * a) / 2);
    if (a < 7.07106781186547) {
      let n = 3.52624965998911e-2 * a + 0.700383064443688;
      n = n * a + 6.37396220353165;
      n = n * a + 33.912866078383;
      n = n * a + 112.079291497871;
      n = n * a + 221.213596169931;
      n = n * a + 220.206867912376;
      let d = 8.83883476483184e-2 * a + 1.75566716318264;
      d = d * a + 16.064177579207;
      d = d * a + 86.7807322029461;
      d = d * a + 296.564248779674;
      d = d * a + 637.333633378831;
      d = d * a + 793.826512519948;
      d = d * a + 440.413735824752;
      tail = (e * n) / d;
    } else {
      let b = a + 0.65;
      b = a + 4 / b;
      b = a + 3 / b;
      b = a + 2 / b;
      b = a + 1 / b;
      tail = e / b / 2.506628274631;
    }
  }
  return x > 0 ? 1 - tail : tail;
}

/** The standard normal density. */
export function normPdf(x: number): number {
  return Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI);
}

export interface BsmInputs {
  /** Underlying price. */
  S: number;
  K: number;
  /** Years to expiry. */
  T: number;
  /** Risk-free rate, continuously compounded. */
  r: number;
  /** Dividend yield, continuously compounded. */
  q: number;
  sigma: number;
}

function d1d2({ S, K, T, r, q, sigma }: BsmInputs): [number, number] {
  const v = sigma * Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + (sigma * sigma) / 2) * T) / v;
  return [d1, d1 - v];
}

/** The model price of a European option. */
export function bsmPrice(right: OptionRight, p: BsmInputs): number {
  const [d1, d2] = d1d2(p);
  const df = Math.exp(-p.r * p.T);
  const dq = Math.exp(-p.q * p.T);
  return right === 'call'
    ? p.S * dq * normCdf(d1) - p.K * df * normCdf(d2)
    : p.K * df * normCdf(-d2) - p.S * dq * normCdf(-d1);
}

/** ∂price/∂S: e^(−qT)·N(d1) for a call, −e^(−qT)·N(−d1) for a put. */
export function bsmDelta(right: OptionRight, p: BsmInputs): number {
  const [d1] = d1d2(p);
  const dq = Math.exp(-p.q * p.T);
  return right === 'call' ? dq * normCdf(d1) : -dq * normCdf(-d1);
}

/** ∂²price/∂S², the same for a call and a put. */
export function bsmGamma(p: BsmInputs): number {
  const [d1] = d1d2(p);
  return (Math.exp(-p.q * p.T) * normPdf(d1)) / (p.S * p.sigma * Math.sqrt(p.T));
}

/** ∂price/∂σ, per 1.00 of volatility. */
export function bsmVega(p: BsmInputs): number {
  const [d1] = d1d2(p);
  return p.S * Math.exp(-p.q * p.T) * normPdf(d1) * Math.sqrt(p.T);
}

/** The forward price S·e^((r − q)T); "at the money" is the strike nearest it. */
export function forwardPrice(S: number, T: number, r: number, q: number): number {
  return S * Math.exp((r - q) * T);
}

const SIGMA_MIN = 1e-4;
const SIGMA_MAX = 5;

/**
 * The volatility at which the model price equals `price`, by Newton's method
 * from a Brenner–Subrahmanyam start, falling back to bisection whenever a
 * step leaves the bracket or vega is too small to steer by. Undefined when no
 * volatility between 0.01% and 500% gives that price: at or below the
 * no-arbitrage floor, at or above the ceiling, or bad inputs.
 */
export function impliedVolatility(
  right: OptionRight,
  price: number,
  base: Omit<BsmInputs, 'sigma'>,
): number | undefined {
  const { S, K, T, r, q } = base;
  if (![price, S, K, T, r, q].every(Number.isFinite)) return undefined;
  if (price <= 0 || S <= 0 || K <= 0 || T <= 0) return undefined;
  const at = (sigma: number) => bsmPrice(right, { ...base, sigma });
  let lo = SIGMA_MIN;
  let hi = SIGMA_MAX;
  const fLo = at(lo) - price;
  const fHi = at(hi) - price;
  // Price rises with σ, so a root exists only when it lies between the two ends.
  if (fLo >= 0 || fHi <= 0) return undefined;
  let sigma = Math.min(Math.max(Math.sqrt((2 * Math.PI) / T) * (price / S), 0.05), 2);
  for (let i = 0; i < 200; i++) {
    const diff = at(sigma) - price;
    if (Math.abs(diff) < 1e-12) return sigma;
    if (diff > 0) hi = sigma;
    else lo = sigma;
    const vega = bsmVega({ ...base, sigma });
    let next = vega > 1e-10 ? sigma - diff / vega : Number.NaN;
    if (!(next > lo && next < hi)) next = (lo + hi) / 2;
    if (Math.abs(next - sigma) < 1e-14) return next;
    sigma = next;
  }
  return sigma;
}

/**
 * Whether a quote is good enough to price from (brief §4 preamble): a bid
 * above zero, an ask above the bid, and a spread of at most 40% of the mid.
 */
export function usableQuote(bid: number | null | undefined, ask: number | null | undefined) {
  if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask)) return false;
  if (!(bid > 0) || !(ask > bid)) return false;
  const mid = (bid + ask) / 2;
  return ask - bid <= 0.4 * mid;
}

/** The mid of a quote, or undefined when either side is missing. */
export function midQuote(bid: number | null | undefined, ask: number | null | undefined) {
  if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask))
    return undefined;
  return (bid + ask) / 2;
}
