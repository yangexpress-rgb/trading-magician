import Decimal from 'decimal.js';
import { nyDate, regularSession, addDays } from '../market/calendar';
import type { Ledger } from './ledger';

/**
 * Valuation (Design v1.0 §10.2; ADR 0020). Open lots are marked at the last
 * price from the tenant's routed feed; a price older than the stale limit, or
 * none at all, is still used (the last good one) but marked stale. Equity is
 * starting equity plus realized net plus unrealized, less the fees already
 * paid on what is still open.
 */

/** Prices older than this mark a valuation stale (the paper stale-data limit, §20 #11). */
export const MARK_STALE_SEC = 60;

export interface Mark {
  price: Decimal;
  at: Date;
  stale: boolean;
}

export interface BookValue {
  runtimeId: string;
  accountId: string;
  instrumentId: string;
  /** Signed: negative is short. */
  quantity: Decimal;
  /** What the open lots cost, signed like the quantity. */
  costBasis: Decimal;
  mark: Mark | null;
  marketValue: Decimal;
  unrealized: Decimal;
  /** Realized to date: net, gross and the fees charged on closed lots. */
  realized: Decimal;
  realizedGross: Decimal;
  fees: Decimal;
  /** Fees already paid on the open lots, charged when they close. */
  openFees: Decimal;
}

/**
 * A mark from a quote's last price. Age counts up to the session's close, so
 * the closing price stays a good mark after the market shuts; a price that
 * stopped well before then is stale.
 */
export function markFromQuote(
  quote: { last: Decimal; at: string },
  now: Date,
  sessionClose: string,
): Mark {
  const until = Math.min(now.getTime(), Date.parse(sessionClose));
  const at = new Date(quote.at);
  return { price: quote.last, at, stale: (until - at.getTime()) / 1000 > MARK_STALE_SEC };
}

const ZERO = new Decimal(0);
const key = (b: { runtimeId: string; accountId: string; instrumentId: string }) =>
  `${b.runtimeId}|${b.accountId}|${b.instrumentId}`;

/**
 * Values every book in the ledger. A book with open lots and no mark keeps a
 * zero unrealized figure and a null mark, which callers report as missing.
 */
export function valueBooks(ledger: Ledger, marks: ReadonlyMap<string, Mark>): BookValue[] {
  const books = new Map<string, BookValue>();
  const book = (b: { runtimeId: string; accountId: string; instrumentId: string }) => {
    let v = books.get(key(b));
    if (!v) {
      v = {
        runtimeId: b.runtimeId,
        accountId: b.accountId,
        instrumentId: b.instrumentId,
        quantity: ZERO,
        costBasis: ZERO,
        mark: marks.get(b.instrumentId) ?? null,
        marketValue: ZERO,
        unrealized: ZERO,
        realized: ZERO,
        realizedGross: ZERO,
        fees: ZERO,
        openFees: ZERO,
      };
      books.set(key(b), v);
    }
    return v;
  };
  for (const lot of ledger.closed) {
    const v = book(lot);
    v.realized = v.realized.plus(lot.net);
    v.realizedGross = v.realizedGross.plus(lot.gross);
    v.fees = v.fees.plus(lot.fees);
  }
  for (const lot of ledger.open) {
    const v = book(lot);
    const sign = lot.side === 'long' ? 1 : -1;
    const qty = lot.quantity.times(sign);
    v.quantity = v.quantity.plus(qty);
    v.costBasis = v.costBasis.plus(lot.openPrice.times(qty).times(lot.multiplier));
    v.openFees = v.openFees.plus(lot.fees);
    if (v.mark) {
      const value = v.mark.price.times(qty).times(lot.multiplier);
      v.marketValue = v.marketValue.plus(value);
      v.unrealized = v.unrealized.plus(value.minus(lot.openPrice.times(qty).times(lot.multiplier)));
    }
  }
  return [...books.values()];
}

export interface EquityTotals {
  realized: Decimal;
  unrealized: Decimal;
  fees: Decimal;
  openFees: Decimal;
  marketValue: Decimal;
  /** Books with open lots whose price is stale or missing. */
  staleMarks: number;
  /** Realized net plus unrealized, less fees paid on open lots. */
  pnl: Decimal;
}

export function totalBooks(books: readonly BookValue[]): EquityTotals {
  const t = {
    realized: ZERO,
    unrealized: ZERO,
    fees: ZERO,
    openFees: ZERO,
    marketValue: ZERO,
    staleMarks: 0,
  };
  for (const b of books) {
    t.realized = t.realized.plus(b.realized);
    t.unrealized = t.unrealized.plus(b.unrealized);
    t.fees = t.fees.plus(b.fees);
    t.openFees = t.openFees.plus(b.openFees);
    t.marketValue = t.marketValue.plus(b.marketValue);
    if (!b.quantity.isZero() && (!b.mark || b.mark.stale)) t.staleMarks += 1;
  }
  return { ...t, pnl: t.realized.plus(t.unrealized).minus(t.openFees) };
}

/**
 * The demo account's starting equity: the same $100,000 an Alpaca paper
 * account starts with. Other accounts take theirs from the broker.
 */
export const DEMO_STARTING_EQUITY = new Decimal(100_000);

/** Equity differences above this are flagged against the broker (Phase 5 decision 7). */
export const EQUITY_TOLERANCE = new Decimal('1.00');

/**
 * The session a valuation at `now` belongs to: today's once it has opened,
 * otherwise the last one. It is final from that session's close on, and the
 * equity history keeps one row per session.
 */
export function valuationSession(now: Date): { date: string; close: string; final: boolean } {
  let date = nyDate(now);
  for (let i = 0; i < 10; i++) {
    const s = regularSession(date);
    if (s && Date.parse(s.open) <= now.getTime()) {
      return { date, close: s.close, final: now.getTime() >= Date.parse(s.close) };
    }
    date = addDays(date, -1);
  }
  throw new Error(`No trading session found before ${now.toISOString()}`);
}
