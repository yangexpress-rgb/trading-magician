import Decimal from 'decimal.js';
import type { PlannedOrder, StrategyDefinition } from '../strategy/schema';
import { isOptionLeg } from '../strategy/schema';
import { yearsTo } from './chain';
import { bsmDelta, impliedVolatility, type OptionRight } from './pricing';
import { OPTIONS_DEFAULTS } from './trading';

/**
 * Combos (options brief v0.2 §§3, 7.2, 7.3, 8.1; ADR 0123, Phase O2): the
 * options legs of one Entry on one underlying and one expiry, traded as one
 * multi-leg order. Shared by validation, the paper runtime and the back test.
 *
 * - Boundedness is proven at save time from the legs' rights and sides alone:
 *   the expiry payoff is piecewise linear with breakpoints at the strikes, so it
 *   is bounded below iff the slope beyond the highest strike (the net number of
 *   calls held) is not negative. A short put not covered by a long put is a
 *   cash-secured put, which is Phase O3's and refused with its own reason.
 * - Dollars come at pricing time: max loss from the net price obtained, and
 *   the broker-shaped buying power (Alpaca reserves the full width of a credit
 *   combo, ignoring the credit).
 */

/** One leg of a priced combo: a signed number of contracts per set (+ held, − sold). */
export interface ComboLeg {
  right: OptionRight;
  strike: Decimal.Value;
  /** Contracts per set, signed: positive bought, negative sold. */
  quantity: number;
}

/** What the legs pay at expiry per set and per share, at underlying price `s`. */
export function payoffAt(legs: readonly ComboLeg[], s: Decimal.Value): Decimal {
  const S = new Decimal(s);
  let total = new Decimal(0);
  for (const l of legs) {
    const k = new Decimal(l.strike);
    const v = l.right === 'call' ? Decimal.max(S.minus(k), 0) : Decimal.max(k.minus(S), 0);
    total = total.plus(v.times(l.quantity));
  }
  return total;
}

export interface ComboShape {
  /** The payoff has a finite minimum. */
  bounded: boolean;
  /** The lowest payoff per share at expiry (≤ 0 when some price loses), when bounded. */
  worst: Decimal | undefined;
  /** The highest payoff per share at expiry, or undefined when it grows without bound. */
  best: Decimal | undefined;
}

/** The expiry payoff's extremes per share, from price 0, each strike and the slope beyond. */
export function comboShape(legs: readonly ComboLeg[]): ComboShape {
  const strikes = [...new Set(legs.map((l) => new Decimal(l.strike).toString()))]
    .map((k) => new Decimal(k))
    .sort((a, b) => a.cmp(b));
  const points = [new Decimal(0), ...strikes];
  const values = points.map((p) => payoffAt(legs, p));
  // Beyond the highest strike the payoff moves by the net calls held per unit of price.
  const slope = legs.filter((l) => l.right === 'call').reduce((n, l) => n + l.quantity, 0);
  const min = Decimal.min(...values);
  const max = Decimal.max(...values);
  return {
    bounded: slope >= 0,
    worst: slope >= 0 ? min : undefined,
    best: slope > 0 ? undefined : max,
  };
}

/** Net debit per share of one set at these per-share prices (+ paid, − received). */
export function netDebit(legs: readonly ComboLeg[], prices: readonly Decimal.Value[]): Decimal {
  return legs.reduce(
    (sum, l, i) => sum.plus(new Decimal(prices[i] ?? 0).times(l.quantity)),
    new Decimal(0),
  );
}

const MULT = OPTIONS_DEFAULTS.standardMultiplier;

/**
 * §7.3 at pricing time: the most one set can lose at expiry, in dollars, at
 * a net debit per share (negative is a credit). Undefined when unbounded.
 */
export function comboMaxLoss(
  legs: readonly ComboLeg[],
  debit: Decimal.Value,
  multiplier: Decimal.Value = MULT,
): Decimal | undefined {
  const { worst } = comboShape(legs);
  if (worst === undefined) return undefined;
  return Decimal.max(new Decimal(debit).minus(worst), 0).times(multiplier);
}

/** The most one set can make at expiry, in dollars, or undefined when unbounded. */
export function comboMaxProfit(
  legs: readonly ComboLeg[],
  debit: Decimal.Value,
  multiplier: Decimal.Value = MULT,
): Decimal | undefined {
  const { best } = comboShape(legs);
  if (best === undefined) return undefined;
  return Decimal.max(best.minus(debit), 0).times(multiplier);
}

/**
 * §8.1 buying power, shaped as Alpaca reserves it, per set: the full width a
 * combo can lose at expiry before any credit, plus any debit paid. A 95/90 put
 * and 105/110 call condor reserves $500 whatever credit it took.
 */
export function comboBuyingPower(
  legs: readonly ComboLeg[],
  debit: Decimal.Value,
  multiplier: Decimal.Value = MULT,
): Decimal | undefined {
  const { worst } = comboShape(legs);
  if (worst === undefined) return undefined;
  return Decimal.max(worst.neg(), 0).plus(Decimal.max(debit, 0)).times(multiplier);
}

/** Greatest common divisor, for a combo's ratios in lowest terms (§5.5). */
export function gcd(values: readonly number[]): number {
  const g2 = (a: number, b: number): number => (b === 0 ? a : g2(b, a % b));
  return values.reduce((g, v) => g2(g, Math.abs(v)), 0);
}

// ---------------------------------------------------------------------------
// Combos in a definition
// ---------------------------------------------------------------------------

export interface DefinitionCombo {
  underlyingId: string;
  accountId: string;
  legs: PlannedOrder[];
}

/** The options legs of `orders` on one underlying and account, when there are two or more (§3). */
export function optionCombos(orders: readonly PlannedOrder[]): DefinitionCombo[] {
  const by = new Map<string, DefinitionCombo>();
  for (const o of orders) {
    if (!isOptionLeg(o)) continue;
    const key = `${o.instrumentId}|${o.accountId}`;
    const c = by.get(key) ?? { underlyingId: o.instrumentId, accountId: o.accountId, legs: [] };
    c.legs.push(o);
    by.set(key, c);
  }
  return [...by.values()].filter((c) => c.legs.length >= 2);
}

/** Whether a definition's Entry holds a combo, or sells an option to open (level 3, §5.4). */
export const hasCombo = (def: StrategyDefinition) =>
  optionCombos(def.entry.orders).length > 0 ||
  def.entry.orders.some((o) => isOptionLeg(o) && o.side === 'sell_short');

/** The signed contracts per set of an Entry leg: bought is positive, sold to open negative. */
export function legSign(o: Pick<PlannedOrder, 'side'>): 1 | -1 {
  return o.side === 'sell_short' ? -1 : 1;
}

export type ComboProblem =
  | 'options_naked_call'
  | 'options_cash_secured_put'
  | 'options_combo_expiry'
  | 'options_combo_size'
  | 'options_combo_legs';

/**
 * §7.3 at save time: why this combo's structure is refused, or undefined.
 * Rights and signs decide boundedness; strikes aren't known until pricing.
 */
export function comboStructureProblem(
  legs: readonly PlannedOrder[],
): { code: ComboProblem; message: string } | undefined {
  const spec = (o: PlannedOrder) => o.option;
  if (legs.length > 4)
    return {
      code: 'options_combo_legs',
      message: `A combo has at most 4 options legs; this one has ${legs.length}`,
    };
  const first = spec(legs[0] as PlannedOrder)?.expiryRule;
  if (
    legs.some((o) => {
      const r = spec(o)?.expiryRule;
      return !r || !first || r.targetDte !== first.targetDte || r.minDte !== first.minDte;
    })
  )
    return {
      code: 'options_combo_expiry',
      message:
        'The options legs of a combo share one expiry: give them the same days to expiry and minimum',
    };
  if (legs.some((o) => o.quantity.type !== 'units' || !/^\d+$/.test(o.quantity.value)))
    return {
      code: 'options_combo_size',
      message: 'Size each leg of a combo in whole contracts, so the legs keep their ratio',
    };
  const net = (right: OptionRight) =>
    legs
      .filter((o) => spec(o)?.right === right)
      .reduce((n, o) => n + legSign(o) * Number(o.quantity.value), 0);
  if (net('call') < 0)
    return {
      code: 'options_naked_call',
      message:
        'This combo sells more calls than it buys, so its loss has no limit as the price rises: buy a call for each call sold',
    };
  if (net('put') < 0)
    return {
      code: 'options_cash_secured_put',
      message:
        'This combo sells more puts than it buys, which is a cash-secured put: buy a put for each put sold (cash-secured puts come later)',
    };
  return undefined;
}

// ---------------------------------------------------------------------------
// The delta rule's app-computed Greeks (Phase O2)
// ---------------------------------------------------------------------------

/**
 * The rate the app's own delta uses when the broker gives no Greeks: a flat
 * 4%, continuously compounded, no dividend yield. Delta near the money moves
 * little with the rate, so the pick it gives is the broker's in all but ties.
 */
export const APP_GREEKS_RATE = 0.04;

/**
 * A contract's delta from its own price (the quote's mid on paper, the bar's
 * close in a back test): implied volatility first, then Black-Scholes delta.
 * Undefined when the price says nothing (no time left, below intrinsic).
 */
export function appDelta(input: {
  right: OptionRight;
  strike: Decimal.Value;
  expiry: string;
  decisionDate: string;
  price: Decimal.Value;
  underlyingPrice: Decimal.Value;
}): number | undefined {
  const T = yearsTo(input.decisionDate, input.expiry);
  const base = {
    S: new Decimal(input.underlyingPrice).toNumber(),
    K: new Decimal(input.strike).toNumber(),
    T,
    r: APP_GREEKS_RATE,
    q: 0,
  };
  const sigma = impliedVolatility(input.right, new Decimal(input.price).toNumber(), base);
  if (sigma === undefined) return undefined;
  const d = bsmDelta(input.right, { ...base, sigma });
  return Number.isFinite(d) ? d : undefined;
}

// ---------------------------------------------------------------------------
// §8.1 Exposure of what is held (Phase O2)
// ---------------------------------------------------------------------------

export interface HeldContract {
  underlyingId: string;
  right: OptionRight;
  strike: Decimal.Value;
  /** Signed contracts held: + long, − short. */
  quantity: Decimal.Value;
  /** Per-share mark. */
  mark: Decimal.Value;
  multiplier: Decimal.Value;
}

/**
 * The exposure of the contracts held on each underlying (§8.1): what they can
 * still lose by expiry from their marks, i.e. their net value now less their
 * worst expiry payoff. For long contracts alone that is their premium value,
 * exactly as Phase O1 counted it; for a defined-risk combo it is its max loss
 * from here (a $5-wide condor taken for 1.50 counts $350, not its legs' sum).
 * A structure with no limit to its loss (never saved, §7.3) counts its legs'
 * whole premium values, as before.
 */
export function heldOptionsExposure(held: readonly HeldContract[]): Decimal {
  const by = new Map<string, HeldContract[]>();
  for (const h of held) by.set(h.underlyingId, [...(by.get(h.underlyingId) ?? []), h]);
  let total = new Decimal(0);
  for (const group of by.values()) {
    const legsValue = group.reduce(
      (s, h) => s.plus(new Decimal(h.quantity).abs().times(h.mark).times(h.multiplier)),
      new Decimal(0),
    );
    const anyShort = group.some((h) => new Decimal(h.quantity).lt(0));
    const mult = new Decimal(group[0]?.multiplier ?? MULT);
    const { worst } = comboShape(
      group.map((h) => ({
        right: h.right,
        strike: h.strike,
        quantity: new Decimal(h.quantity).toNumber(),
      })),
    );
    if (!anyShort || worst === undefined) {
      total = total.plus(legsValue);
      continue;
    }
    const net = group.reduce(
      (s, h) => s.plus(new Decimal(h.quantity).times(h.mark).times(h.multiplier)),
      new Decimal(0),
    );
    total = total.plus(Decimal.max(net.minus(worst.times(mult)), 0));
  }
  return total;
}
