import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import {
  CAPACITY_RISK_CODES,
  checkPreTradeRisk,
  collarAtRelease,
  collarBreach,
  holdsForOpenCollar,
  sampledInSessionAt,
  riskRefusalText,
  type RiskCheckInput,
} from './risk';

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

  it("checks the account's own exposure limit after the strategy's (ADR 0107)", () => {
    // The order is 100 × $50 = $5,000.
    const account = (gross: number) => ({ maxExposure: '30000', grossExposure: d(gross) });
    expect(code({ account: account(25_000) })).toBeUndefined();
    expect(code({ account: account(25_001) })).toBe('risk_account_exposure');
    const r = checkPreTradeRisk({ ...base, account: account(25_001) });
    expect(r.checks.find((c) => c.code === 'risk_account_exposure')).toEqual({
      code: 'risk_account_exposure',
      passed: false,
      limit: '30000',
      value: '30001.00',
    });
    expect(riskRefusalText(r)).toBe('Account exposure: $30,001, limit $30,000');
    // Closing orders lower risk and skip it, as they skip the strategy's.
    expect(code({ closing: true, account: account(100_000) })).toBeUndefined();
    // It is a capacity refusal: it clears as positions close (N300).
    expect(CAPACITY_RISK_CODES).toContain('risk_account_exposure');
  });

  it("holds a live account's openings to its pilot caps (ADR 0109)", () => {
    // The order is 100 × $50 = $5,000.
    const pilot = (maxOrder: string, maxExposure: string, gross = 0) => ({
      grossExposure: d(gross),
      pilot: { maxOrder, maxExposure },
    });
    expect(code({ account: pilot('5000', '25000') })).toBeUndefined();
    expect(code({ account: pilot('500', '25000') })).toBe('risk_pilot_order');
    const r = checkPreTradeRisk({ ...base, account: pilot('500', '25000') });
    expect(riskRefusalText(r)).toBe('Pilot cap per order: $5,000, limit $500');
    expect(code({ account: pilot('5000', '2500') })).toBe('risk_pilot_exposure');
    expect(code({ account: pilot('5000', '25000', 20_001) })).toBe('risk_pilot_exposure');
    // Closing orders are never trapped by the caps.
    expect(code({ closing: true, account: pilot('1', '1', 100_000) })).toBeUndefined();
    // The exposure cap clears as positions close; the per-order cap does not.
    expect(CAPACITY_RISK_CODES).toContain('risk_pilot_exposure');
    expect(CAPACITY_RISK_CODES).not.toContain('risk_pilot_order');
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

describe('collar anchored at release, never on a prior session (N325)', () => {
  // The incident: decided Friday 2026-11-20 16:05 ET at $48.19; Monday 2026-11-23 opens at $51.15.
  const FRIDAY_DECISION = { last: d('48.19'), at: '2026-11-20T21:05:00Z' };
  const OPEN = Date.parse('2026-11-23T14:30:00Z');
  const sec = (n: number) => new Date(OPEN + n * 1000).toISOString();

  it('A1: sends the gapped open; the Friday decision price is not an input at all', () => {
    const r = collarAtRelease({
      snapshot: { last: d('51.15'), at: sec(1) },
      sendQuote: { last: d('51.16'), at: sec(1.4) },
      now: OPEN + 1500,
      collarPct: '5',
    });
    expect(r.kind).toBe('send');
    if (r.kind !== 'send') return;
    expect(r.anchor).toMatchObject({ source: 'release_snapshot', at: sec(1) });
    expect(r.anchor.price.toString()).toBe('51.15');
  });

  it('A2: blocks a move past the collar between release and send, naming both prices and times', () => {
    const r = collarAtRelease({
      snapshot: { last: d('50.00'), at: sec(1) },
      sendQuote: { last: d('53.00'), at: sec(3) },
      now: OPEN + 3000,
      collarPct: '5',
    });
    expect(r.kind).toBe('block');
    if (r.kind !== 'block') return;
    expect(r.anchor).toMatchObject({ source: 'release_snapshot', at: sec(1) });
    expect(r.price).toMatchObject({ source: 'send_attempt', at: sec(3) });
    expect(r.movePct.toFixed(1)).toBe('6.0');
    expect(r.reason).toBe(
      'Not sent: the price moved 6.0% while the order was being sent, from $50.00 at 9:30:01 AM ET ' +
        '(release snapshot) to $53.00 at 9:30:03 AM ET (at the send attempt). The price collar allows 5%.',
    );
    expect(r.reason).not.toMatch(/decided/);
  });

  it('A4: never anchors on a price from an earlier session; it waits for a current one', () => {
    // Friday's price offered as the snapshot (e.g. no trade yet today): wait, never compare.
    expect(
      collarAtRelease({
        snapshot: FRIDAY_DECISION,
        sendQuote: { last: d('51.15'), at: sec(1) },
        now: OPEN + 1000,
        collarPct: '5',
      }).kind,
    ).toBe('wait');
    // A pre-market quote the same morning is not from the session either.
    expect(sampledInSessionAt('2026-11-23T14:29:59Z', OPEN + 1000)).toBe(false);
    expect(sampledInSessionAt(sec(0), OPEN + 1000)).toBe(true);
    expect(sampledInSessionAt(FRIDAY_DECISION.at, OPEN + 1000)).toBe(false);
    // Nor a stale price at the send attempt.
    expect(
      collarAtRelease({
        snapshot: { last: d('51.15'), at: sec(1) },
        sendQuote: FRIDAY_DECISION,
        now: OPEN + 2000,
        collarPct: '5',
      }).kind,
    ).toBe('wait');
    // Nor while the market is closed.
    expect(sampledInSessionAt(FRIDAY_DECISION.at, Date.parse('2026-11-21T15:00:00Z'))).toBe(false);
  });
});

describe('riskRefusalText (N287)', () => {
  it('names the check that refused the order, with its figures', () => {
    const refused = (failed: { code: string; limit?: string; value?: string }) =>
      riskRefusalText({
        ok: false,
        code: failed.code as never,
        checks: [{ code: 'stale_data', passed: true }, { ...failed, passed: false } as never],
      });
    expect(refused({ code: 'risk_active_orders', limit: '20', value: '20' })).toBe(
      'Active orders: 20 already working, limit 20',
    );
    expect(refused({ code: 'risk_order_size', limit: '10000', value: '12500.5' })).toBe(
      'Order size: $12,500.5, limit $10,000',
    );
    expect(refused({ code: 'risk_daily_loss' })).toBe('Daily loss');
  });

  it('is null for an order that passed', () => {
    expect(riskRefusalText({ ok: true, checks: [] })).toBeNull();
    expect(riskRefusalText(undefined)).toBeNull();
  });
});
