import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { sizeOrder } from '../execution/sizing';
import { atrStopDistance, atrStopHit, atrStopLevel, riskSeries, riskSizingCap } from './risk-exits';
import type { PlannedOrder, StrategyDefinition } from './schema';
import { parseDefinition } from './serialize';
import { context, order, STOCK_A, STOCK_B, validDefinition } from './test-fixtures';
import { validateStrategy } from './validate';

/** Design v1.2 item 9: risk-based sizing from ATR, and a fixed ATR stop. */
const d = (v: string | number) => new Decimal(v);
/** Risk a % of equity over the Entry's ATR distance (ADR 0049; was `risk_atr`). */
const riskAtr = (value = '1'): PlannedOrder['quantity'] => ({
  type: 'risk',
  value,
  rounding: 'down',
  amountIn: 'pct_equity',
  distanceFrom: 'atr',
});
const base = {
  referencePrice: d(400),
  equity: d(100_000),
  position: d(0),
  lotSize: d(1),
  distance: { atrPeriod: 20, atrMultiple: '2' },
};

function sized(): StrategyDefinition {
  const def = validDefinition();
  def.entry.orders = [order('buy-a', { quantity: riskAtr() })];
  def.entry.risk = { atrPeriod: 20, atrMultiple: '2' };
  def.exit.rules = [{ kind: 'atrStop', id: 'atr-stop' }];
  return def;
}

const codes = (def: StrategyDefinition) => {
  const v = validateStrategy(def, context());
  return [...v.errors, ...v.warnings].map((e) => e.code);
};

describe('risk_atr sizing', () => {
  it('sizes floor(equity × risk% ÷ (ATR × multiple)) and explains it', () => {
    const r = sizeOrder({ ...base, order: { side: 'buy', quantity: riskAtr() }, atr: d('4.1234') });
    // 100,000 × 1% = 1,000; 4.1234 × 2 = 8.2468; 1,000 ÷ 8.2468 = 121.26 → 121.
    expect(r.ok && r.quantity.toString()).toBe('121');
    expect(r.ok && r.sizing).toEqual({
      method: 'risk_atr',
      equity: '100000',
      riskPct: '1',
      atrPeriod: 20,
      atr: '4.1234',
      atrMultiple: '2',
      stopDistance: '8.2468',
      riskQuantity: '121',
      quantity: '121',
    });
  });

  it('sells short for a short Entry', () => {
    const r = sizeOrder({
      ...base,
      order: { side: 'sell_short', quantity: riskAtr() },
      atr: d('4.1234'),
    });
    expect(r.ok && r.direction).toBe('sell');
  });

  it('places nothing without an ATR, or when the quantity rounds to 0', () => {
    const o = { side: 'buy' as const, quantity: riskAtr() };
    expect(sizeOrder({ ...base, order: o })).toEqual({ ok: false, code: 'no_atr' });
    const zero = sizeOrder({ ...base, order: o, atr: d(600) });
    expect(zero.ok).toBe(false);
    expect(!zero.ok && zero.code).toBe('zero_quantity');
    expect(!zero.ok && zero.sizing?.riskQuantity).toBe('0');
  });

  it('is capped by limits, never the other way round', () => {
    const r = sizeOrder({
      ...base,
      order: { side: 'buy', quantity: riskAtr('5') },
      atr: d('4.1234'),
      cap: { notional: d(10_000), by: 'max_order_size' },
    });
    // The risk budget allows 606 shares ($242,400); $10,000 ÷ $400 allows 25.
    expect(r.ok && r.quantity.toString()).toBe('25');
    expect(r.ok && r.sizing).toMatchObject({ riskQuantity: '606', cappedBy: 'max_order_size' });
  });

  it('caps at the tightest of buying power, order size and exposure', () => {
    const risk = {
      ...validDefinition().risk,
      maxOrderNotional: '20000',
      maxStrategyExposure: '25000',
    };
    expect(riskSizingCap(risk, d(100_000), d(0))).toEqual({
      notional: d(20000),
      by: 'max_order_size',
    });
    expect(riskSizingCap(risk, d(100_000), d(10_000))).toEqual({
      notional: d(15000),
      by: 'max_exposure',
    });
    expect(riskSizingCap(risk, d(12_000), d(0))).toEqual({
      notional: d(12000),
      by: 'buying_power',
    });
  });

  it('lets a Close leg pre-filled from a risk-sized Entry close what is held', () => {
    const r = sizeOrder({
      ...base,
      position: d(37),
      order: { side: 'close', quantity: riskAtr() },
    });
    expect(r.ok && [r.quantity.toString(), r.direction, r.closing]).toEqual(['37', 'sell', true]);
    const def = sized();
    def.exit.orders = [order('close-a', { side: 'close', quantity: riskAtr() })];
    expect(codes(def)).toEqual([]);
  });

  it('leaves fixed quantities alone', () => {
    const r = sizeOrder({
      ...base,
      order: { side: 'buy', quantity: { type: 'units', value: '7', rounding: 'down' } },
    });
    expect(r.ok && r.quantity.toString()).toBe('7');
    expect(r.ok && r.sizing).toBeUndefined();
  });
});

describe('ATR stop', () => {
  it('reads the Entry risk distance unless it has its own', () => {
    const def = sized();
    expect(atrStopDistance(def)).toEqual({ atrPeriod: 20, atrMultiple: '2' });
    def.exit.rules = [{ kind: 'atrStop', id: 's', override: { atrPeriod: 10, atrMultiple: '3' } }];
    expect(atrStopDistance(def)).toEqual({ atrPeriod: 10, atrMultiple: '3' });
  });

  it('is fixed at entry: below a long, above a short, and close-based', () => {
    const long = atrStopLevel(d(400), d('4.1234'), '2', true);
    const short = atrStopLevel(d(400), d('4.1234'), '2', false);
    expect(long.toString()).toBe('391.7532');
    expect(short.toString()).toBe('408.2468');
    expect(atrStopHit(d('391.75'), long, true)).toBe(true);
    expect(atrStopHit(d('391.7532'), long, true)).toBe(false);
    expect(atrStopHit(d('408.25'), short, false)).toBe(true);
    expect(atrStopHit(d('400'), short, false)).toBe(false);
  });

  it('asks for the daily ATR and close of the first Entry leg', () => {
    const series = riskSeries(sized());
    expect(series.map((e) => e.kind)).toContain('indicator');
    expect(JSON.stringify(series)).toContain(STOCK_A);
  });
});

describe('validation', () => {
  it('accepts risk sizing with an ATR stop, and round-trips it', () => {
    const def = sized();
    expect(codes(def)).toEqual([]);
    expect(parseDefinition(JSON.parse(JSON.stringify(def)))).toEqual(def);
  });

  it('needs the Entry risk distance, at most 100% risk, and only on Entry legs', () => {
    const def = sized();
    def.entry.orders[0]!.quantity = riskAtr('150');
    delete def.entry.risk;
    expect(codes(def)).toEqual(
      expect.arrayContaining(['invalid_quantity', 'risk_needs_distance', 'atr_stop_no_distance']),
    );
    const half = sized();
    half.entry.orders[0]!.quantity = { type: 'risk', value: '1', rounding: 'down' };
    expect(codes(half)).toContain('risk_incomplete');
    const exit = sized();
    exit.exit.orders = [order('sell-a', { side: 'sell', quantity: riskAtr() })];
    expect(codes(exit)).toContain('risk_atr_entry_only');
  });

  it('allows one ATR stop per Exit and warns when Entry has several instruments', () => {
    const def = sized();
    def.exit.rules = [
      ...def.exit.rules!,
      { kind: 'atrStop', id: 'atr-2', override: { atrPeriod: 10, atrMultiple: '3' } },
    ];
    expect(codes(def)).toContain('duplicate_atr_stop');
    const two = sized();
    two.entry.orders.push(order('buy-b', { instrumentId: STOCK_B }));
    expect(codes(two)).toContain('atr_stop_first_leg');
  });
});
