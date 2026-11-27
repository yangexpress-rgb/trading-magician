import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { checkPreTradeRisk as legacyRisk } from './a1-legacy/risk';
import { sizeOrder as legacySize } from './a1-legacy/sizing';
import { checkPreTradeRisk, type RiskCheckInput } from './risk';
import { sizeOrder, type SizingInput } from './sizing';
import { ORDER_SIDES, QUANTITY_ROUNDINGS } from '../strategy/schema';

/**
 * Options brief v0.2 A1 / §5.7 (ADR 0123): the multiplier pass-through leaves
 * every stock and ETF result byte-identical. For multiplier 1 (and with no
 * multiplier at all) sizing and the pre-trade risk check give exactly what the
 * functions on main 576f055 gave, frozen in `a1-legacy/`, on a generated
 * fixture set.
 */

const dec = (min: number, max: number) =>
  fc.integer({ min: min * 100, max: max * 100 }).map((n) => new Decimal(n).div(100));
const money = fc.integer({ min: 1, max: 5_000_000 }).map((n) => String(n / 100));

const sizing: fc.Arbitrary<SizingInput> = fc.record({
  order: fc.record({
    side: fc.constantFrom(...ORDER_SIDES),
    quantity: fc.oneof(
      fc.record({
        type: fc.constantFrom('units', 'notional', 'pct_equity'),
        value: money,
        rounding: fc.constantFrom(...QUANTITY_ROUNDINGS),
      }),
      fc.record({
        type: fc.constant('risk'),
        value: money,
        rounding: fc.constantFrom(...QUANTITY_ROUNDINGS),
        amountIn: fc.constantFrom('dollars', 'pct_equity'),
        distanceFrom: fc.constantFrom('stop_price', 'atr'),
      }),
    ),
  }) as fc.Arbitrary<SizingInput['order']>,
  referencePrice: dec(-1, 900),
  stopPrice: fc.option(dec(0, 900), { nil: undefined }),
  equity: dec(0, 2_000_000),
  position: fc.integer({ min: -500, max: 500 }).map((n) => new Decimal(n)),
  lotSize: fc.constantFrom(new Decimal(1), new Decimal(10)),
  atr: fc.option(dec(0, 20), { nil: undefined }),
  distance: fc.option(
    fc.record({
      atrPeriod: fc.integer({ min: 2, max: 50 }),
      atrMultiple: fc.constantFrom('1', '1.5', '2', '3'),
    }),
    { nil: undefined },
  ),
  cap: fc.option(
    fc.record({
      notional: dec(0, 100_000),
      by: fc.constantFrom(
        'max_order_size' as const,
        'max_exposure' as const,
        'buying_power' as const,
      ),
    }),
    { nil: undefined },
  ),
});

const risk: fc.Arbitrary<RiskCheckInput> = fc.record({
  risk: fc.record(
    {
      maxOrderNotional: money,
      maxStrategyExposure: money,
      maxActiveOrders: fc.integer({ min: 1, max: 50 }),
      dailyLossLimit: money,
      maxDrawdownPct: fc.constantFrom('5', '10'),
      maxInstrumentsHeld: fc.integer({ min: 1, max: 20 }),
      priceCollarPct: fc.constantFrom('1', '2', '20'),
    },
    { requiredKeys: [] },
  ),
  closing: fc.boolean(),
  quantity: fc.integer({ min: 0, max: 5_000 }).map((n) => new Decimal(n)),
  referencePrice: dec(0.01, 900),
  limitPrice: fc.option(dec(0.01, 900), { nil: undefined }),
  activeOrders: fc.integer({ min: 0, max: 60 }),
  grossExposure: dec(0, 500_000),
  equity: dec(0, 500_000),
  dailyLossHit: fc.boolean(),
  drawdownHit: fc.boolean(),
  openPositions: fc.integer({ min: 0, max: 25 }),
  instrumentHeld: fc.boolean(),
  account: fc.option(
    fc.record(
      {
        maxExposure: money,
        grossExposure: dec(0, 500_000),
        pilot: fc.record({ maxOrder: money, maxExposure: money }),
      },
      { requiredKeys: ['grossExposure'] },
    ),
    { nil: undefined },
  ),
  priceAgeSec: fc.option(fc.integer({ min: 0, max: 300 }), { nil: undefined }),
  staleDataSec: fc.option(fc.integer({ min: 1, max: 120 }), { nil: undefined }),
}) as fc.Arbitrary<RiskCheckInput>;

const bytes = (v: unknown) => JSON.stringify(v);

describe('A1: the multiplier pass-through is byte-identical for multiplier 1 (§5.7)', () => {
  it('sizes every generated order exactly as main did', () => {
    fc.assert(
      fc.property(sizing, (input) => {
        const before = bytes(legacySize(input));
        expect(bytes(sizeOrder(input))).toBe(before);
        expect(bytes(sizeOrder({ ...input, multiplier: 1 }))).toBe(before);
        expect(bytes(sizeOrder({ ...input, multiplier: '1' }))).toBe(before);
      }),
      { numRuns: 3_000, seed: 20261127 },
    );
  });

  it('risk-checks every generated order exactly as main did', () => {
    fc.assert(
      fc.property(risk, (input) => {
        const before = bytes(legacyRisk(input));
        expect(bytes(checkPreTradeRisk(input))).toBe(before);
        expect(bytes(checkPreTradeRisk({ ...input, multiplier: '1' }))).toBe(before);
      }),
      { numRuns: 3_000, seed: 20261127 },
    );
  });

  it('a contract of 100 costs 100 times its premium', () => {
    const order = {
      side: 'buy' as const,
      quantity: { type: 'notional' as const, value: '1000', rounding: 'down' as const },
    };
    const r = sizeOrder({
      order,
      referencePrice: new Decimal('2.40'),
      equity: new Decimal(100_000),
      position: new Decimal(0),
      lotSize: new Decimal(1),
      multiplier: 100,
    });
    // floor(1000 ÷ (2.40 × 100)) = 4 contracts.
    expect(r.ok && r.quantity.toString()).toBe('4');
    const checked = checkPreTradeRisk({
      risk: { maxOrderNotional: '900' },
      closing: false,
      quantity: new Decimal(4),
      referencePrice: new Decimal('2.40'),
      activeOrders: 0,
      grossExposure: new Decimal(0),
      equity: new Decimal(100_000),
      dailyLossHit: false,
      drawdownHit: false,
      openPositions: 0,
      instrumentHeld: false,
      multiplier: 100,
    });
    expect(checked.code).toBe('risk_order_size');
    expect(checked.checks[0]?.value).toBe('960.00');
  });
});
