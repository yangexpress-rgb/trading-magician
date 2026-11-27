import Decimal from 'decimal.js';
import { OPTIONS_DEFAULTS } from './trading';

/**
 * Options prices for orders (options trading brief v0.2 §§7.1, 8.2, 11.1;
 * ADR 0123). Entries and exits are limit orders at the quote's mid, re-priced
 * once a third of the way to the touch; no order is sent on an old quote or a
 * wide spread. The back test fills options with its own function; the equity
 * fill model is untouched.
 */

export interface OptionQuote {
  bid: Decimal.Value;
  ask: Decimal.Value;
  /** When the quote was made (ISO). */
  at: string;
}

export type QuoteRefusal = 'option_quote_missing' | 'option_quote_stale' | 'option_spread_wide';

/** Mid of a two-sided quote, or undefined when it has no usable bid and ask. */
export function quoteMid(q: Pick<OptionQuote, 'bid' | 'ask'>): Decimal | undefined {
  const bid = new Decimal(q.bid);
  const ask = new Decimal(q.ask);
  if (!bid.isFinite() || !ask.isFinite() || ask.lte(0) || bid.lt(0) || ask.lt(bid))
    return undefined;
  return bid.plus(ask).div(2);
}

/**
 * §8.2: why an options order may not go on this quote, or null when it may.
 * The age limit applies in market hours only; the spread is (ask − bid) ÷ mid.
 */
export function optionQuoteProblem(input: {
  quote: OptionQuote | undefined;
  now: Date;
  marketOpen: boolean;
  maxSpreadPct?: Decimal.Value;
  maxAgeSec?: number;
  contract: string;
}): { code: QuoteRefusal; message: string; detail: Record<string, string> } | null {
  const { quote, contract } = input;
  const maxAge = input.maxAgeSec ?? OPTIONS_DEFAULTS.quoteMaxAgeSec;
  const maxSpread = new Decimal(input.maxSpreadPct ?? OPTIONS_DEFAULTS.maxSpreadPct);
  const mid = quote ? quoteMid(quote) : undefined;
  if (!quote || !mid || mid.lte(0))
    return {
      code: 'option_quote_missing',
      message: `The order for the ${contract} wasn't sent because it had no two-sided quote`,
      detail: {},
    };
  const age = Math.max(0, Math.round((input.now.getTime() - Date.parse(quote.at)) / 1000));
  if (input.marketOpen && age > maxAge)
    return {
      code: 'option_quote_stale',
      message: `The order for the ${contract} wasn't sent because its quote was ${age} seconds old (the limit is ${maxAge})`,
      detail: { ageSec: String(age), limitSec: String(maxAge) },
    };
  const spreadPct = new Decimal(quote.ask).minus(quote.bid).div(mid).times(100);
  if (spreadPct.gt(maxSpread))
    return {
      code: 'option_spread_wide',
      message: `The order for the ${contract} wasn't sent because its spread was ${spreadPct.toDecimalPlaces(1).toString()}% of the mid (the limit is ${maxSpread.toString()}%)`,
      detail: {
        spreadPct: spreadPct.toDecimalPlaces(2).toString(),
        limitPct: maxSpread.toString(),
      },
    };
  return null;
}

/** Options prices go in cents. A buy rounds up and a sell down only on the re-price. */
const cents = (d: Decimal, mode: Decimal.Rounding = Decimal.ROUND_HALF_UP) =>
  d.toDecimalPlaces(2, mode);

/** §7.1: the first limit, the mid, in cents. */
export const midLimit = (q: Pick<OptionQuote, 'bid' | 'ask'>) => {
  const mid = quoteMid(q);
  return mid ? cents(mid) : undefined;
};

/**
 * §7.1: the one re-price, from a fresh quote: mid plus a third of the way to
 * the touch (a buy toward the ask, a sell toward the bid).
 */
export function repriceLimit(
  q: Pick<OptionQuote, 'bid' | 'ask'>,
  direction: 'buy' | 'sell',
): Decimal | undefined {
  const mid = quoteMid(q);
  if (!mid) return undefined;
  if (direction === 'buy')
    return cents(mid.plus(new Decimal(q.ask).minus(mid).div(3)), Decimal.ROUND_UP);
  return Decimal.max(cents(mid.minus(mid.minus(q.bid).div(3)), Decimal.ROUND_DOWN), 0);
}

/**
 * §11.1, back tests only: a buy fills at mid + slippage% of the premium, a
 * sell at mid − slippage%, never below zero. Before quotes were recorded the
 * mid is a trade price, so results say they were priced from trade prices.
 */
export function optionFillPrice(
  mid: Decimal.Value,
  direction: 'buy' | 'sell',
  slippagePct: Decimal.Value = OPTIONS_DEFAULTS.fillSlippagePct,
): Decimal {
  const m = new Decimal(mid);
  const k = new Decimal(slippagePct).div(100);
  return Decimal.max(
    direction === 'buy' ? m.times(k.plus(1)) : m.times(new Decimal(1).minus(k)),
    0,
  );
}

/** Labels shown wherever an options back test's results are (§11.2). */
export const OPTIONS_BACKTEST_LABEL = 'Options priced from trade prices, not quotes';
