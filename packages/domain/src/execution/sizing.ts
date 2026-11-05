import Decimal from 'decimal.js';
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
}

export type SizingResult =
  | { ok: true; quantity: Decimal; direction: Direction; closing: boolean }
  | { ok: false; code: SizingSkip };

/** Why no order is placed: nothing to close, or the size rounds to zero. */
export type SizingSkip = 'nothing_to_close' | 'zero_quantity' | 'no_stop_distance' | 'no_price';

const ZERO = new Decimal(0);

export function sizeOrder({
  order,
  referencePrice: ref,
  stopPrice,
  equity,
  position: pos,
  lotSize,
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
    case 'risk_sized': {
      const perUnitRisk = stopPrice ? ref.minus(stopPrice).abs() : ZERO;
      if (perUnitRisk.isZero()) return { ok: false, code: 'no_stop_distance' };
      qty = v.div(perUnitRisk);
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
