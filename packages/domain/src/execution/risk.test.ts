import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { checkPreTradeRisk, collarBreach, holdsForOpenCollar, type RiskCheckInput } from './risk';

const d = (v: string | number) => new Decimal(v);
/** The paper limits approved on 2026-10-04. */
const PAPER = {
  maxOrderNotional: '10000',
  maxStrategyExposure: '25000',
  maxActiveOrders: 10,
  dailyLossLimit: '1000',
  priceCollarPct: '5',
};
const base: RiskCheckInput = {
  risk: PAPER,
  closing: false,
  quantity: d(100),
  referencePrice: d(50),
  activeOrders: 0,
  grossExposure: d(0),
  equity: d(100_000),
  dailyLossHit: false,
  drawdownHit: false,
  openPositions: 0,
  instrumentHeld: false,
};
const code = (extra: Partial<RiskCheckInput>) => checkPreTradeRisk({ ...base, ...extra }).code;

describe('checkPreTradeRisk', () => {
  it('passes an order within every limit and records each check', () => {
    const r = checkPreTradeRisk(base);
    expect(r.ok).toBe(true);
    expect(r.checks.map((c) => c.code)).toEqual([
      'risk_active_orders',
      'risk_order_size',
      'risk_exposure',
      'buying_power',
      'risk_daily_loss',
    ]);
  });

  it('applies each limit at its boundary', () => {
    expect(code({ quantity: d(200) })).toBeUndefined();
    expect(code({ quantity: d(201) })).toBe('risk_order_size');
    expect(code({ grossExposure: d(20_000) })).toBeUndefined();
    expect(code({ grossExposure: d(20_001) })).toBe('risk_exposure');
    expect(code({ activeOrders: 9 })).toBeUndefined();
    expect(code({ activeOrders: 10 })).toBe('risk_active_orders');
    expect(code({ equity: d(4_999) })).toBe('buying_power');
    expect(code({ dailyLossHit: true })).toBe('risk_daily_loss');
  });

  it('lets closing orders through the exposure limits but not the active-order cap', () => {
    expect(code({ closing: true, quantity: d(10_000), dailyLossHit: true })).toBeUndefined();
    expect(code({ closing: true, activeOrders: 10 })).toBe('risk_active_orders');
  });

  it('rejects limit prices outside the collar', () => {
    expect(code({ limitPrice: d('52.5') })).toBeUndefined();
    expect(code({ limitPrice: d('52.51') })).toBe('risk_collar');
    expect(code({ closing: true, limitPrice: d(40) })).toBe('risk_collar');
  });

  it('rejects stale prices when an age is given', () => {
    expect(code({ priceAgeSec: 60, staleDataSec: 60 })).toBeUndefined();
    expect(code({ priceAgeSec: 61, staleDataSec: 60 })).toBe('stale_data');
  });

  it('caps open positions only for new instruments', () => {
    const risk = { ...PAPER, maxInstrumentsHeld: 2 };
    expect(code({ risk, openPositions: 2 })).toBe('risk_open_positions');
    expect(code({ risk, openPositions: 2, instrumentHeld: true })).toBeUndefined();
  });

  it('reports the failing value and limit', () => {
    const r = checkPreTradeRisk({ ...base, quantity: d(300) });
    expect(r.checks.at(-1)).toEqual({
      code: 'risk_order_size',
      passed: false,
      limit: '10000',
      value: '15000.00',
    });
  });
});

describe('price collar on orders that fill at the open (§7.2)', () => {
  const risk = { priceCollarPct: '5' };

  it('holds opening market orders without extended hours', () => {
    const buy = { side: 'buy', orderType: 'market', extendedHours: false };
    expect(holdsForOpenCollar(buy, risk)).toBe(true);
    expect(holdsForOpenCollar({ ...buy, side: 'sell_short' }, risk)).toBe(true);
    expect(holdsForOpenCollar({ ...buy, side: 'close' }, risk)).toBe(false);
    expect(holdsForOpenCollar({ ...buy, side: 'sell' }, risk)).toBe(false);
    expect(holdsForOpenCollar({ ...buy, orderType: 'limit' }, risk)).toBe(false);
    expect(holdsForOpenCollar({ ...buy, extendedHours: true }, risk)).toBe(false);
    expect(holdsForOpenCollar(buy, {})).toBe(false);
  });

  it('measures the move from the reference price', () => {
    const r = collarBreach(new Decimal('70'), new Decimal('74.2'), '5');
    expect(r.movePct.toFixed(1)).toBe('6.0');
    expect(r.breached).toBe(true);
    expect(collarBreach(new Decimal('70'), new Decimal('66.6'), '5').breached).toBe(false);
    expect(collarBreach(new Decimal('0'), new Decimal('10'), '5').breached).toBe(false);
  });
});
