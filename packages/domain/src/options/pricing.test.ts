import { describe, expect, it } from 'vitest';
import { computeChain } from './chain';
import {
  bsmDelta,
  bsmGamma,
  bsmPrice,
  forwardPrice,
  impliedVolatility,
  normCdf,
  usableQuote,
  type BsmInputs,
} from './pricing';

/**
 * Fixture F8 (options data brief v2 §7): the pricing package against
 * published Black-Scholes values. Published prices are printed to two or four
 * decimals, so prices are compared at that precision and the volatility
 * recovered from a published price is held to what that precision allows
 * (half a unit in the last place ÷ vega); recovering σ from the model's own
 * price is held to 1e-6, as are delta and gamma against the analytic
 * derivatives worked out numerically.
 */

// Hull, Options, Futures and Other Derivatives, Example 15.6.
const hull: BsmInputs = { S: 42, K: 40, T: 0.5, r: 0.1, q: 0, sigma: 0.2 };
// Haug, The Complete Guide to Option Pricing Formulas, §1.1.1 (call) and §1.1.4 (Merton, dividend yield, put).
const haugCall: BsmInputs = { S: 60, K: 65, T: 0.25, r: 0.08, q: 0, sigma: 0.3 };
const haugMerton: BsmInputs = { S: 100, K: 95, T: 0.5, r: 0.1, q: 0.05, sigma: 0.2 };
// Haug §2.1: delta (Black-76, so q = r) and gamma.
const haugDelta: BsmInputs = { S: 105, K: 100, T: 0.5, r: 0.1, q: 0.1, sigma: 0.36 };
const haugGamma: BsmInputs = { S: 55, K: 60, T: 0.75, r: 0.1, q: 0, sigma: 0.3 };

describe('normal distribution', () => {
  it('matches tabulated values', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 14);
    expect(normCdf(1.96)).toBeCloseTo(0.9750021048517795, 12);
    expect(normCdf(-1)).toBeCloseTo(0.15865525393145707, 12);
    expect(Math.abs(normCdf(-8) / 6.22096057427178e-16 - 1)).toBeLessThan(1e-7);
  });
});

describe('Black-Scholes-Merton prices (F8)', () => {
  it('reproduces published prices', () => {
    expect(bsmPrice('call', hull)).toBeCloseTo(4.76, 2);
    expect(bsmPrice('put', hull)).toBeCloseTo(0.81, 2);
    expect(bsmPrice('call', haugCall)).toBeCloseTo(2.1334, 4);
    expect(bsmPrice('put', haugMerton)).toBeCloseTo(2.4648, 4);
  });

  it('reproduces published delta and gamma', () => {
    expect(bsmDelta('call', haugDelta)).toBeCloseTo(0.5946, 4);
    expect(bsmDelta('put', haugDelta)).toBeCloseTo(-0.3566, 4);
    expect(bsmGamma(haugGamma)).toBeCloseTo(0.0278, 4);
  });

  it('delta and gamma equal the analytic derivatives within 1e-6', () => {
    for (const p of [hull, haugCall, haugMerton, haugDelta, haugGamma]) {
      const h = 1e-3;
      for (const right of ['call', 'put'] as const) {
        const up = bsmPrice(right, { ...p, S: p.S + h });
        const down = bsmPrice(right, { ...p, S: p.S - h });
        const mid = bsmPrice(right, p);
        expect(Math.abs(bsmDelta(right, p) - (up - down) / (2 * h))).toBeLessThan(1e-6);
        expect(Math.abs(bsmGamma(p) - (up - 2 * mid + down) / (h * h))).toBeLessThan(1e-6);
      }
    }
  });

  it('holds put-call parity', () => {
    for (const p of [hull, haugCall, haugMerton]) {
      const parity = p.S * Math.exp(-p.q * p.T) - p.K * Math.exp(-p.r * p.T);
      expect(bsmPrice('call', p) - bsmPrice('put', p)).toBeCloseTo(parity, 10);
    }
  });
});

describe('implied volatility (F8)', () => {
  it('recovers σ from published prices to their printed precision', () => {
    const base = { ...haugCall, sigma: Number.NaN };
    expect(Math.abs((impliedVolatility('call', 2.1334, base) as number) - 0.3)).toBeLessThan(1e-5);
    const merton = { ...haugMerton, sigma: Number.NaN };
    expect(Math.abs((impliedVolatility('put', 2.4648, merton) as number) - 0.2)).toBeLessThan(1e-5);
  });

  it('recovers σ from the model price within 1e-6 across strikes, maturities and volatilities', () => {
    for (const sigma of [0.05, 0.15, 0.3, 0.8, 2]) {
      for (const T of [2 / 365, 20 / 365, 0.25, 1, 2]) {
        for (const K of [70, 90, 100, 110, 140]) {
          for (const right of ['call', 'put'] as const) {
            const p = { S: 100, K, T, r: 0.045, q: 0.012, sigma };
            const price = bsmPrice(right, p);
            const floor =
              right === 'call'
                ? Math.max(0, 100 * Math.exp(-p.q * T) - K * Math.exp(-p.r * T))
                : Math.max(0, K * Math.exp(-p.r * T) - 100 * Math.exp(-p.q * T));
            // Without time value worth a ten-thousandth of a cent, no volatility is recoverable.
            if (price - floor < 1e-6) continue;
            const iv = impliedVolatility(right, price, p);
            expect(iv, `${right} K=${K} T=${T} σ=${sigma}`).toBeDefined();
            expect(Math.abs((iv as number) - sigma)).toBeLessThan(1e-6);
          }
        }
      }
    }
  });

  it('is unknown for a price no volatility gives', () => {
    const base = { S: 100, K: 90, T: 0.25, r: 0.05, q: 0 };
    expect(impliedVolatility('call', 5, base)).toBeUndefined(); // below intrinsic
    expect(impliedVolatility('call', 120, base)).toBeUndefined(); // above the underlying
    expect(impliedVolatility('put', 0, base)).toBeUndefined();
    expect(impliedVolatility('put', 1, { ...base, T: 0 })).toBeUndefined();
  });
});

describe('quote rules (F8)', () => {
  it('uses a quote only with a bid, an ask above it and a spread within 40% of mid', () => {
    expect(usableQuote(8.0, 8.2)).toBe(true);
    expect(usableQuote(0, 0.1)).toBe(false); // no bid
    expect(usableQuote(1, 1)).toBe(false); // ask not above bid
    expect(usableQuote(1.2, 1.1)).toBe(false);
    expect(usableQuote(1, 1.6)).toBe(false); // spread 0.6 > 40% of 1.3
    expect(usableQuote(1, 1.4)).toBe(true); // spread 0.4 ≤ 40% of 1.2
    expect(usableQuote(null, 1)).toBe(false);
  });

  it('solves only out-of-the-money options and gives the in-the-money one the same IV', () => {
    const market = { asOfDate: '2026-11-02', S: 100, r: 0.04, q: 0 };
    const T = 30 / 365;
    const F = forwardPrice(100, T, 0.04, 0);
    const price = (right: 'call' | 'put', K: number, sigma: number) =>
      bsmPrice(right, { S: 100, K, T, r: 0.04, q: 0, sigma });
    const expiry = '2026-12-02';
    const out = computeChain(market, [
      // A put below the forward priced at 25% vol, and its in-the-money call quoted absurdly.
      { expiry, strike: 90, right: 'put', price: price('put', 90, 0.25) },
      { expiry, strike: 90, right: 'call', price: 50 },
      // An in-the-money put at 110 with a price, but no price for the out-of-the-money call.
      { expiry, strike: 110, right: 'put', price: price('put', 110, 0.4) },
      { expiry, strike: 110, right: 'call', price: undefined },
      // At the money: both sides solved from their own prices.
      { expiry, strike: 100, right: 'call', price: price('call', 100, 0.2) },
      { expiry, strike: 100, right: 'put', price: price('put', 100, 0.22) },
    ]);
    expect(F).toBeGreaterThan(100);
    expect(out[0]?.iv).toBeCloseTo(0.25, 8);
    expect(out[1]?.iv).toBeCloseTo(0.25, 8); // the ITM call takes the OTM put's IV, not its own quote
    expect(out[1]?.delta).toBeGreaterThan(0.5);
    expect(out[2]?.iv).toBeUndefined(); // the ITM put's own price is not used
    expect(out[3]?.iv).toBeUndefined();
    expect(out[4]?.iv).toBeCloseTo(0.2, 8);
    expect(out[5]?.iv).toBeCloseTo(0.22, 8);
  });
});
