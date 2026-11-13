import Decimal from 'decimal.js';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { PlannedOrder } from '../strategy/schema';
import { sizeOrder, type SizingInput } from './sizing';

const d = (v: string | number) => new Decimal(v);
const order = (
  side: PlannedOrder['side'],
  type: PlannedOrder['quantity']['type'],
  value: string,
  rounding: 'up' | 'down' | 'nearest' = 'down',
): SizingInput['order'] => ({ side, quantity: { type, value, rounding } });
const base = { referencePrice: d(50), equity: d(100_000), position: d(0), lotSize: d(1) };

describe('sizeOrder', () => {
  it('sizes by units, notional, percentage of equity and risk', () => {
    expect(sizeOrder({ ...base, order: order('buy', 'units', '7') })).toMatchObject({
      ok: true,
      direction: 'buy',
      closing: false,
    });
    const q = (o: SizingInput['order'], extra: Partial<SizingInput> = {}) => {
      const r = sizeOrder({ ...base, ...extra, order: o });
      return r.ok ? r.quantity.toString() : r.code;
    };
    expect(q(order('buy', 'notional', '1020'))).toBe('20');
    expect(q(order('buy', 'notional', '1020', 'nearest'))).toBe('20');
    expect(q(order('buy', 'notional', '1040', 'nearest'))).toBe('21');
    // Round up (N272): any part of a unit buys a whole one, so never below 1.
    expect(q(order('buy', 'notional', '1020', 'up'))).toBe('21');
    expect(q(order('buy', 'notional', '1000', 'up'))).toBe('20');
    expect(q(order('buy', 'notional', '10', 'up'))).toBe('1');
    expect(q(order('buy', 'notional', '10'))).toBe('zero_quantity');
    expect(q(order('sell_short', 'pct_equity', '5'))).toBe('100');
    const risk = (
      value: string,
      extra: Partial<PlannedOrder['quantity']>,
    ): SizingInput['order'] => ({
      side: 'buy',
      quantity: { type: 'risk', value, rounding: 'down', ...extra },
    });
    const dollarsToStop = risk('200', { amountIn: 'dollars', distanceFrom: 'stop_price' });
    expect(q(dollarsToStop, { stopPrice: d(48) })).toBe('100');
    expect(q(dollarsToStop)).toBe('no_stop_distance');
  });

  it('sizes one risk quantity four ways: dollars or % of equity, to the stop or the ATR distance (ADR 0049)', () => {
    const risk = (
      value: string,
      extra: Partial<PlannedOrder['quantity']>,
    ): SizingInput['order'] => ({
      side: 'buy',
      quantity: { type: 'risk', value, rounding: 'down', ...extra },
    });
    const q = (o: SizingInput['order'], extra: Partial<SizingInput> = {}) => {
      const r = sizeOrder({ ...base, order: o, ...extra });
      return r.ok ? r.quantity.toString() : r.code;
    };
    // 1% of 100,000 = 1,000 over a $2 stop distance = 500 shares.
    expect(
      q(risk('1', { amountIn: 'pct_equity', distanceFrom: 'stop_price' }), { stopPrice: d(48) }),
    ).toBe('500');
    const atr = { atr: d(2), distance: { atrPeriod: 14, atrMultiple: '2' } };
    // ATR 2 × 2 = $4 a share: 1,000 / 4 = 250; $400 / 4 = 100.
    expect(q(risk('1', { amountIn: 'pct_equity', distanceFrom: 'atr' }), atr)).toBe('250');
    expect(q(risk('400', { amountIn: 'dollars', distanceFrom: 'atr' }), atr)).toBe('100');
    expect(q(risk('1', { amountIn: 'pct_equity', distanceFrom: 'atr' }))).toBe('no_atr');
  });

  it('rounds to the lot size', () => {
    const r = sizeOrder({ ...base, lotSize: d('0.01'), order: order('buy', 'notional', '1000.7') });
    expect(r.ok && r.quantity.toString()).toBe('20.01');
  });

  it('caps closing orders at what is held', () => {
    const held = { ...base, position: d(30) };
    const q = (o: SizingInput['order'], extra = held) => {
      const r = sizeOrder({ ...extra, order: o });
      return r.ok ? `${r.direction} ${r.quantity.toString()}` : r.code;
    };
    expect(q(order('sell', 'units', '50'))).toBe('sell 30');
    expect(q(order('close', 'units', '1'))).toBe('sell 30');
    expect(q(order('reduce', 'units', '10'))).toBe('sell 10');
    expect(q(order('buy_to_cover', 'units', '10'))).toBe('nothing_to_close');
    expect(q(order('buy_to_cover', 'units', '10'), { ...base, position: d(-4) })).toBe('buy 4');
    expect(q(order('close', 'units', '1'), base)).toBe('nothing_to_close');
  });

  it('skips orders that round to zero and prices that are missing', () => {
    expect(sizeOrder({ ...base, order: order('buy', 'notional', '10') })).toEqual({
      ok: false,
      code: 'zero_quantity',
    });
    expect(sizeOrder({ ...base, referencePrice: d(0), order: order('buy', 'units', '1') })).toEqual(
      { ok: false, code: 'no_price' },
    );
  });

  it('never sizes past the requested notional or below zero', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1_000_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (notional, cents) => {
          const price = d(cents).div(100);
          const r = sizeOrder({
            ...base,
            referencePrice: price,
            order: order('buy', 'notional', String(notional)),
          });
          if (!r.ok) return;
          expect(r.quantity.gt(0)).toBe(true);
          expect(r.quantity.isInteger()).toBe(true);
          expect(r.quantity.times(price).lte(notional)).toBe(true);
        },
      ),
    );
  });
});
