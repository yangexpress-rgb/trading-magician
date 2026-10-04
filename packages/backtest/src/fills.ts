import type { Bar, OrderType } from '@tm/domain';
import Decimal from 'decimal.js';

export type Direction = 'buy' | 'sell';

export interface FillableOrder {
  direction: Direction;
  type: OrderType;
  limit?: Decimal | undefined;
  stop?: Decimal | undefined;
  /** Set once a stop or stop-limit has triggered on an earlier bar. */
  stopTriggered: boolean;
}

export interface FillQuote {
  /** Price before slippage. */
  base: Decimal;
  /** Price after slippage, which is what the account pays or receives. */
  price: Decimal;
  stopTriggered: boolean;
}

/**
 * Where an order fills on one bar, or undefined if it doesn't (Design v1.0
 * §7.2; defaults proposed for §20 #6):
 * - market orders fill at the open, plus slippage;
 * - limit orders fill at the open if that is already at or better than the
 *   limit, otherwise at the limit if the bar trades through it, with no slippage;
 * - stop orders trigger when the bar reaches the stop and then fill at the
 *   stop, or at the open if it gapped past, plus slippage;
 * - stop-limit orders trigger like stops and then behave as limits.
 */
export function quoteFill(
  order: FillableOrder,
  bar: Bar,
  slippageBps: Decimal,
): FillQuote | undefined {
  const buy = order.direction === 'buy';
  const slip = (p: Decimal) =>
    p.times(new Decimal(1).plus(slippageBps.div(10_000).times(buy ? 1 : -1)));
  const reached = (level: Decimal) => (buy ? bar.high.gte(level) : bar.low.lte(level));
  const atOrBetter = (p: Decimal, limit: Decimal) => (buy ? p.lte(limit) : p.gte(limit));
  const touchedLimit = (limit: Decimal) => (buy ? bar.low.lte(limit) : bar.high.gte(limit));

  switch (order.type) {
    case 'market':
      return { base: bar.open, price: slip(bar.open), stopTriggered: false };
    case 'limit': {
      const limit = order.limit;
      if (!limit) return undefined;
      if (atOrBetter(bar.open, limit))
        return { base: bar.open, price: bar.open, stopTriggered: false };
      if (touchedLimit(limit)) return { base: limit, price: limit, stopTriggered: false };
      return undefined;
    }
    case 'stop': {
      const stop = order.stop;
      if (!stop) return undefined;
      if (order.stopTriggered)
        return { base: bar.open, price: slip(bar.open), stopTriggered: true };
      const gapped = buy ? bar.open.gte(stop) : bar.open.lte(stop);
      if (gapped) return { base: bar.open, price: slip(bar.open), stopTriggered: true };
      if (reached(stop)) return { base: stop, price: slip(stop), stopTriggered: true };
      return undefined;
    }
    case 'stop_limit': {
      const { stop, limit } = order;
      if (!stop || !limit) return undefined;
      let trigger: Decimal | undefined;
      if (order.stopTriggered) trigger = bar.open;
      else if (buy ? bar.open.gte(stop) : bar.open.lte(stop)) trigger = bar.open;
      else if (reached(stop)) trigger = stop;
      if (!trigger) return undefined;
      if (atOrBetter(trigger, limit)) return { base: trigger, price: trigger, stopTriggered: true };
      if (touchedLimit(limit)) return { base: limit, price: limit, stopTriggered: true };
      // Triggered but not fillable within the limit on this bar; it keeps working.
      return undefined;
    }
  }
}

/** Shares one order may take from a bar under the volume cap. */
export function volumeCap(bar: Bar, maxVolumePct: Decimal): Decimal {
  return bar.volume.times(maxVolumePct).div(100).floor();
}

/** Whether a stop or stop-limit order's stop is reached on this bar. */
export function stopReached(order: FillableOrder, bar: Bar): boolean {
  if (!order.stop || (order.type !== 'stop' && order.type !== 'stop_limit')) return false;
  return order.direction === 'buy' ? bar.high.gte(order.stop) : bar.low.lte(order.stop);
}
