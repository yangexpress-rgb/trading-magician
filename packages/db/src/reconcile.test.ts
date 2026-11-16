import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { explainedByInFlight } from './reconcile';

const d = (n: number) => new Decimal(n);

describe('explainedByInFlight (N277)', () => {
  it('lets working buys explain a broker that is ahead of the app', () => {
    // Two strategies buying AXON 15 each: app saw 14 filled, broker 21.
    expect(explainedByInFlight(d(7), { buy: d(16), sell: d(0) })).toBe(true);
    expect(explainedByInFlight(d(17), { buy: d(16), sell: d(0) })).toBe(false);
  });

  it('lets working sells explain a broker that is behind', () => {
    expect(explainedByInFlight(d(-3), { buy: d(0), sell: d(5) })).toBe(true);
    expect(explainedByInFlight(d(-3), { buy: d(10), sell: d(0) })).toBe(false);
  });

  it('explains nothing without working orders', () => {
    expect(explainedByInFlight(d(1), undefined)).toBe(false);
  });
});
