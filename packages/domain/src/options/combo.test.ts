import { describe, expect, it } from 'vitest';
import type { PlannedOrder, StrategyDefinition } from '../strategy/schema';
import { CAPS, context, PAPER_ACCOUNT, validDefinition } from '../strategy/test-fixtures';
import { mirrorEntryOrders } from '../strategy/mirror';
import { validateStrategy } from '../strategy/validate';
import {
  comboBuyingPower,
  comboMaxLoss,
  comboMaxProfit,
  comboShape,
  comboStructureProblem,
  appDelta,
  heldOptionsExposure,
  type ComboLeg,
  type HeldContract,
} from './combo';
import { bsmDelta } from './pricing';
import { comboTargetPct } from './exits';

/**
 * Combos (options brief v0.2 §§7.3, 8.1; ADR 0123, Phase O2): boundedness at
 * save time, dollars at pricing time (A3), exposure and buying power (A7).
 */

const call = (strike: number, quantity: number): ComboLeg => ({ right: 'call', strike, quantity });
const put = (strike: number, quantity: number): ComboLeg => ({ right: 'put', strike, quantity });
// §7.3: sell the 105 call, buy the 110 call.
const vertical = [call(105, -1), call(110, 1)];
// §7.3: sell 95 put / buy 90 put / sell 105 call / buy 110 call.
const condor = [put(95, -1), put(90, 1), call(105, -1), call(110, 1)];

describe('combo payoff (A3, A7)', () => {
  it('bounds the 105/110 call vertical with a worst case of $500 a set', () => {
    const shape = comboShape(vertical);
    expect(shape.bounded).toBe(true);
    expect(shape.worst?.times(100).neg().toString()).toBe('500');
  });

  it('prices max loss from the net credit: $380 for the vertical at 1.20, $350 for the condor at 1.50', () => {
    expect(comboMaxLoss(vertical, '-1.20')?.toString()).toBe('380');
    expect(comboMaxLoss(condor, '-1.50')?.toString()).toBe('350');
    // A debit vertical loses at most what it paid.
    expect(comboMaxLoss([call(105, 1), call(110, -1)], '2')?.toString()).toBe('200');
    expect(comboMaxProfit([call(105, 1), call(110, -1)], '2')?.toString()).toBe('300');
  });

  it('counts two condors as $700 of exposure, and reserves the full $500 width for one (A7)', () => {
    expect(comboMaxLoss(condor, '-1.50')?.times(2).toString()).toBe('700');
    expect(comboBuyingPower(condor, '-1.50')?.toString()).toBe('500');
    // A debit combo reserves what it pays.
    expect(comboBuyingPower([call(105, 1), call(110, -1)], '2')?.toString()).toBe('200');
  });

  it('counts what is held by what it can still lose: two condors at their 1.50 credit are $700 (A7)', () => {
    const held = (
      u: string,
      right: 'call' | 'put',
      strike: number,
      q: number,
      mark: string,
    ): HeldContract => ({
      underlyingId: u,
      right,
      strike,
      quantity: q,
      mark,
      multiplier: 100,
    });
    // Marks that add up to the 1.50 credit: 0.50 + 0.25 on each side.
    const one = (u: string, sets: number) => [
      held(u, 'put', 95, -sets, '1.00'),
      held(u, 'put', 90, sets, '0.25'),
      held(u, 'call', 105, -sets, '1.00'),
      held(u, 'call', 110, sets, '0.25'),
    ];
    expect(heldOptionsExposure(one('ZZZ', 2)).toString()).toBe('700');
    expect(heldOptionsExposure([...one('ZZZ', 1), ...one('YYY', 1)]).toString()).toBe('700');
    // A long call alone counts its premium value, exactly as in Phase O1.
    expect(heldOptionsExposure([held('ZZZ', 'call', 100, 3, '2.10')]).toString()).toBe('630');
  });

  it('finds no bound for a naked short call', () => {
    expect(comboShape([call(105, -1)]).bounded).toBe(false);
    expect(comboMaxLoss([call(105, -1)], '-2')).toBeUndefined();
  });

  it('reads a combo’s profit target as a percent of its max profit', () => {
    // Condor sold for 1.50 (max profit $150); bought back for 0.75 is half of it.
    const h = (
      right: 'call' | 'put',
      strike: number,
      quantity: number,
      paid: string,
      now: string,
    ) => ({
      right,
      strike,
      quantity,
      premiumPaid: paid,
      premiumNow: now,
      expiry: '2026-12-18',
    });
    const pct = comboTargetPct([
      h('put', 95, -1, '1.00', '0.50'),
      h('put', 90, 1, '0.25', '0.10'),
      h('call', 105, -1, '1.00', '0.50'),
      h('call', 110, 1, '0.25', '0.15'),
    ]);
    expect(pct?.toString()).toBe('50');
  });
});

const leg = (
  id: string,
  side: PlannedOrder['side'],
  right: 'call' | 'put',
  pct: number,
  base: PlannedOrder,
  dte = 30,
): PlannedOrder => ({
  ...base,
  id,
  legLabel: id,
  side,
  quantity: { type: 'units', value: '1', rounding: 'down' },
  option: {
    right,
    strikeRule: { type: 'moneynessPct', pct },
    expiryRule: { targetDte: dte, minDte: 7 },
  },
});

function comboDef(legs: (base: PlannedOrder) => PlannedOrder[]): StrategyDefinition {
  const def = validDefinition();
  const base = def.entry.orders[0]!;
  def.entry.orders = legs(base);
  def.exit.mirrorEntry = true;
  def.exit.orders = mirrorEntryOrders(def.entry.orders);
  return def;
}

const level = (n: number) =>
  context({
    optionsTradingEnabled: true,
    accounts: new Map([
      [
        PAPER_ACCOUNT,
        {
          nickname: 'Options paper',
          mode: 'paper',
          isActive: true,
          capabilities: { ...CAPS, optionsLevel: n },
        },
      ],
    ]),
  });
const errors = (def: StrategyDefinition, ctx = level(3)) =>
  validateStrategy(def, ctx).errors.map((e) => e.code);

describe('combos at save time (A3)', () => {
  it('refuses a naked short call and a lone short put, each with its own reason', () => {
    const naked = comboDef((b) => [leg('Sell call', 'sell_short', 'call', 5, b)]);
    expect(errors(naked)).toContain('options_naked_call');
    expect(
      validateStrategy(naked, level(3)).errors.find((e) => e.code === 'options_naked_call')
        ?.message,
    ).toMatch(/loss has no limit/);
    const csp = comboDef((b) => [leg('Sell put', 'sell_short', 'put', 5, b)]);
    expect(errors(csp)).toContain('options_cash_secured_put');
  });

  it('accepts the 105/110 call vertical and the iron condor at level 3, not at level 2', () => {
    const v = comboDef((b) => [
      leg('Sell 105 call', 'sell_short', 'call', 5, b),
      leg('Buy 110 call', 'buy', 'call', 10, b),
    ]);
    expect(errors(v)).toEqual([]);
    expect(errors(v, level(2))).toContain('options_level');
    const ic = comboDef((b) => [
      leg('Sell 95 put', 'sell_short', 'put', 5, b),
      leg('Buy 90 put', 'buy', 'put', 10, b),
      leg('Sell 105 call', 'sell_short', 'call', 5, b),
      leg('Buy 110 call', 'buy', 'call', 10, b),
    ]);
    expect(errors(ic)).toEqual([]);
  });

  it('refuses a combo whose legs have different expiries, or are sized in dollars', () => {
    const cal = comboDef((b) => [
      leg('Sell call', 'sell_short', 'call', 5, b, 30),
      leg('Buy call', 'buy', 'call', 5, b, 60),
    ]);
    expect(errors(cal)).toContain('options_combo_expiry');
    const legs = comboDef((b) => [
      leg('Sell call', 'sell_short', 'call', 5, b),
      {
        ...leg('Buy call', 'buy', 'call', 10, b),
        quantity: { type: 'notional', value: '500', rounding: 'down' },
      },
    ]);
    expect(comboStructureProblem(legs.entry.orders)?.code).toBe('options_combo_size');
  });

  it('mirrors a combo’s Entry into Exit legs that keep each leg’s option', () => {
    const v = comboDef((b) => [
      leg('Sell 105 call', 'sell_short', 'call', 5, b),
      leg('Buy 110 call', 'buy', 'call', 10, b),
    ]);
    expect(v.exit.orders.map((o) => [o.side, o.option?.right])).toEqual([
      ['buy_to_cover', 'call'],
      ['sell', 'call'],
    ]);
    expect(errors(v)).toEqual([]);
  });
});

describe("the delta rule's app Greeks (Phase O2)", () => {
  it('recovers the delta of a contract priced by the same model', () => {
    // 30 days, 25% volatility, at the app's 4% rate: price the 105 call, then read its delta back.
    const T = 30 / 365;
    const base = { S: 100, K: 105, T, r: 0.04, q: 0, sigma: 0.25 };
    const price = 0.9; // close to the model's price; the delta follows the implied volatility
    const d = appDelta({
      right: 'call',
      strike: 105,
      expiry: '2026-12-27',
      decisionDate: '2026-11-27',
      price,
      underlyingPrice: 100,
    });
    expect(d).toBeGreaterThan(0.15);
    expect(d).toBeLessThan(0.35);
    expect(bsmDelta('call', base)).toBeGreaterThan(0.15);
  });

  it('gives nothing for a price below intrinsic value', () => {
    expect(
      appDelta({
        right: 'put',
        strike: 110,
        expiry: '2026-12-27',
        decisionDate: '2026-11-27',
        price: 5,
        underlyingPrice: 100,
      }),
    ).toBeUndefined();
  });
});
