import { quoteAgeSec, type Quote } from '@tm/domain';

/**
 * The stale-price watch's decision for one pass (§8.6, N276, ADR 0096).
 *
 * A price that has not changed for a while is not the same as a feed that has
 * stopped. The free Alpaca feed (IEX) sees a small share of the market, so a
 * quiet stock's last trade and quote can sit still for minutes while the feed
 * answers every pass. A quote the feed gave this pass is therefore current
 * when the feed is live: some price it gave this pass changed within the
 * threshold. Only when nothing it gave is fresh, or a price is missing, is a
 * price stale.
 *
 * Each instrument keeps its own "stale since" time, so two stocks that are
 * briefly quiet one after the other no longer add up to one long outage.
 */

export interface WatchedPrice {
  instrumentId: string;
  symbol: string;
  quote: Quote | undefined;
}

export interface FeedVerdict {
  /** Symbols whose price is missing or stale this pass, as the incident names them. */
  bad: string[];
  /** Instrument id → since when it has been stale or missing, epoch ms. */
  staleSince: Record<string, number>;
  /** Symbols stale or missing for at least `pauseAfterMs`, with how long, in seconds. */
  lost: { symbol: string; seconds: number }[];
  /** Whether the feed gave a fresh price this pass. */
  feedLive: boolean;
}

export function feedVerdict(input: {
  prices: readonly WatchedPrice[];
  /** A liquid instrument's quote this pass, asked for only when no watched price is fresh. */
  heartbeat?: Quote | undefined;
  now: Date;
  staleDataSec: number;
  pauseAfterMs: number;
  /** The previous pass's per-instrument times. */
  staleSince: Readonly<Record<string, number>>;
}): FeedVerdict {
  const { now, staleDataSec } = input;
  const t = now.getTime();
  const fresh = (q: Quote | undefined) =>
    q !== undefined && q.marketOpen && quoteAgeSec(q, now) <= staleDataSec;
  const feedLive = input.prices.some((p) => fresh(p.quote)) || fresh(input.heartbeat);

  const bad: string[] = [];
  const staleSince: Record<string, number> = {};
  const lost: FeedVerdict['lost'] = [];
  for (const p of input.prices) {
    const q = p.quote;
    let problem: string | undefined;
    if (!q) problem = `${p.symbol} (no price)`;
    // Outside the session the last quote simply stands; that is not a feed problem.
    else if (q.marketOpen && !feedLive && quoteAgeSec(q, now) > staleDataSec) problem = p.symbol;
    if (!problem) continue;
    bad.push(problem);
    const since = input.staleSince[p.instrumentId] ?? t;
    staleSince[p.instrumentId] = since;
    if (t - since >= input.pauseAfterMs)
      lost.push({ symbol: p.symbol, seconds: Math.round((t - since) / 1000) });
  }
  return { bad, staleSince, lost, feedLive };
}

/**
 * How old a price counts as for the pre-trade stale-data check: a quote the
 * feed gave this pass is current while the feed is live (N276).
 */
export function effectivePriceAgeSec(quote: Quote, now: Date, feedLive: boolean): number {
  return feedLive ? 0 : quoteAgeSec(quote, now);
}
