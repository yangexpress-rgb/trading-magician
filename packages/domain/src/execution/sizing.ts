import Decimal from 'decimal.js';
import type { RiskSizing } from '../strategy/risk-exits';
import type { PlannedOrder } from '../strategy/schema';

/**
 * Turns a planned order into a quantity and direction (Design v1.0 §6.6). The
 * back-test engine and the paper runtime both size orders here, so a strategy
 * trades the same quantities in simulation and in paper execution.
 */

export type Direction = 'buy' | 'sell';

export interface SizingInput {
  order: Pick<PlannedOrder, 'side' | 'quantity'>;
  /** Current price of the order's instrument; must be positive. */
  referencePrice: Decimal;
  /** Evaluated stop price, needed for risk-sized orders. */
  stopPrice?: Decimal | undefined;
  /** Strategy equity, for percentage-of-equity sizing. */
  equity: Decimal;
  /** Signed quantity this strategy cycle already holds in the instrument. */
  position: Decimal;
  /** Smallest tradable quantity step (1 for whole shares). */
  lotSize: Decimal;
  /** `risk` from the ATR only: ATR(period) of the instrument's daily bars now. */
  atr?: Decimal | undefined;
  /** `risk` from the ATR only: the Entry's risk distance (ADR 0049). */
  distance?: { atrPeriod: number; atrMultiple: string } | undefined;
  /**
   * `risk` from the ATR only: the most this order may be worth under the strategy's
   * and account's limits, and which limit that is. Risk sizing narrows a
   * position; it never overrides a limit, so the quantity is capped to it.
   */
  cap?: { notional: Decimal; by: NonNullable<RiskSizing['cappedBy']> } | undefined;
}

export type SizingResult =
  | {
      ok: true;
      quantity: Decimal;
      direction: Direction;
      closing: boolean;
      /** `risk` from the ATR: how the quantity was worked out. */
      sizing?: RiskSizing;
    }
  | { ok: false; code: SizingSkip; sizing?: RiskSizing };

/** Why no order is placed: nothing to close, or the size rounds to zero. */
export type SizingSkip =
  'nothing_to_close' | 'zero_quantity' | 'no_stop_distance' | 'no_price' | 'no_atr';

const ZERO = new Decimal(0);

export function sizeOrder({
  order,
  referencePrice: ref,
  stopPrice,
  equity,
  position: pos,
  lotSize,
  atr,
  distance,
  cap,
}: SizingInput): SizingResult {
  if (ref.lte(0)) return { ok: false, code: 'no_price' };
  const v = new Decimal(order.quantity.value);
  let qty: Decimal;
  switch (order.quantity.type) {
    case 'units':
      qty = v;
      break;
    case 'notional':
      qty = v.div(ref);
      break;
    case 'pct_equity':
      qty = equity.times(v).div(100).div(ref);
      break;
    case 'risk': {
      // One risk quantity (ADR 0049): an amount in dollars or % of equity, over
      // the distance to the stop (the stop price, or the Entry's ATR distance).
      if ((order.quantity.distanceFrom ?? 'stop_price') === 'atr') {
        // A Close leg pre-filled from a risk-sized Entry closes what is held.
        if (order.side === 'close') {
          qty = pos.abs();
          break;
        }
        return sizeByAtr({
          order,
          referencePrice: ref,
          equity,
          position: pos,
          lotSize,
          atr,
          distance,
          cap,
        });
      }
      const perUnitRisk = stopPrice ? ref.minus(stopPrice).abs() : ZERO;
      if (perUnitRisk.isZero()) return { ok: false, code: 'no_stop_distance' };
      const amount =
        order.quantity.amountIn === 'pct_equity' ? equity.times(v).div(100) : v;
      qty = amount.div(perUnitRisk);
      break;
    }
  }
  const lots = qty.div(lotSize);
  qty = (order.quantity.rounding === 'nearest' ? lots.round() : lots.floor()).times(lotSize);

  let direction: Direction;
  let closing = false;
  switch (order.side) {
    case 'buy':
      direction = 'buy';
      break;
    case 'sell_short':
      direction = 'sell';
      break;
    case 'sell':
      direction = 'sell';
      closing = true;
      qty = Decimal.min(qty, Decimal.max(pos, 0));
      break;
    case 'buy_to_cover':
      direction = 'buy';
      closing = true;
      qty = Decimal.min(qty, Decimal.max(pos.negated(), 0));
      break;
    case 'close':
      direction = pos.gt(0) ? 'sell' : 'buy';
      closing = true;
      qty = pos.abs();
      break;
    case 'reduce':
      direction = pos.gt(0) ? 'sell' : 'buy';
      closing = true;
      qty = Decimal.min(qty, pos.abs());
      break;
  }
  if (qty.lte(0)) return { ok: false, code: closing ? 'nothing_to_close' : 'zero_quantity' };
  return { ok: true, quantity: qty, direction, closing };
}

/**
 * v1.2 item 9: quantity = floor((equity × risk% ÷ 100) ÷ (ATR × multiple)),
 * or floor(dollars ÷ (ATR × multiple)), in whole lots, capped to the limits
 * in `cap`. No ATR (too little history) or a quantity of 0 places nothing,
 * and says why.
 */
function sizeByAtr({
  order,
  referencePrice: ref,
  equity,
  lotSize,
  atr,
  distance: riskDistance,
  cap,
}: SizingInput): SizingResult {
  const multiple = riskDistance?.atrMultiple ?? '0';
  const period = riskDistance?.atrPeriod ?? 0;
  if (!atr || atr.lte(0)) return { ok: false, code: 'no_atr' };
  // Figures as shown in the trade list, so the quantity checks by hand exactly.
  const atrShown = atr.toDecimalPlaces(4);
  const equityShown = equity.toDecimalPlaces(2);
  const distance = atrShown.times(multiple);
  if (distance.lte(0)) return { ok: false, code: 'no_stop_distance' };
  const dollars = order.quantity.amountIn === 'dollars';
  const riskQty = (dollars
    ? new Decimal(order.quantity.value)
    : equityShown.times(order.quantity.value).div(100)
  )
    .div(distance)
    .div(lotSize)
    .floor()
    .times(lotSize);
  let qty = Decimal.max(riskQty, 0);
  let cappedBy: RiskSizing['cappedBy'];
  if (cap) {
    const most = Decimal.max(cap.notional, 0).div(ref).div(lotSize).floor().times(lotSize);
    if (most.lt(qty)) {
      qty = most;
      cappedBy = cap.by;
    }
  }
  const sizing: RiskSizing = {
    method: 'risk_atr',
    equity: equityShown.toString(),
    ...(dollars
      ? { riskAmount: new Decimal(order.quantity.value).toString() }
      : { riskPct: new Decimal(order.quantity.value).toString() }),
    atrPeriod: period,
    atr: atrShown.toString(),
    atrMultiple: new Decimal(multiple).toString(),
    stopDistance: distance.toString(),
    riskQuantity: riskQty.toString(),
    quantity: qty.toString(),
    ...(cappedBy ? { cappedBy } : {}),
  };
  if (qty.lte(0)) return { ok: false, code: 'zero_quantity', sizing };
  const direction: Direction = order.side === 'sell_short' ? 'sell' : 'buy';
  return { ok: true, quantity: qty, direction, closing: false, sizing };
}
