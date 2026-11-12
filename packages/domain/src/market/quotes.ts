import type Decimal from 'decimal.js';

/**
 * Live quotes (Design v1.0 §6.5, §17.1). Every quote keeps the provider's
 * timestamp, the time the app received it, and its source, so staleness checks
 * and audits can tell them apart.
 */
export interface Quote {
  instrumentId: string;
  symbol: string;
  bid: Decimal;
  ask: Decimal;
  last: Decimal;
  /** Quantity a single order can take at this quote. */
  size: Decimal;
  /** Provider timestamp, ISO 8601 UTC. */
  at: string;
  receivedAt: string;
  source: string;
  /** False once the session has closed; the quote is then the last one of that session. */
  marketOpen: boolean;
}

export interface QuoteRequest {
  instrumentId: string;
  symbol: string;
}

/** A source of current prices. Real feeds sit behind this in Phase 4. */
export interface LiveQuoteProvider {
  readonly id: string;
  latestQuote(ref: QuoteRequest): Promise<Quote | undefined>;
  /**
   * Many instruments' latest quotes in few requests, by instrument id, for
   * feeds that serve several symbols per call (ADR 0087). Instruments without
   * a quote are left out. Feeds without it are asked one at a time.
   */
  latestQuotes?(refs: readonly QuoteRequest[]): Promise<Map<string, Quote>>;
}

/** Seconds between a quote's provider time and `now`. */
export function quoteAgeSec(quote: Pick<Quote, 'at'>, now: Date): number {
  return Math.max(0, (now.getTime() - Date.parse(quote.at)) / 1000);
}
