import { quoteAgeSec, type Quote } from '@tm/domain';
import type { MissReason } from './quote-hub';

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
  /** Why the quote is missing, when the feed said (N328). */
  miss?: MissReason | undefined;
}

/** Why a watched price is not current (N328). */
export type PriceProblem = MissReason | 'no_price' | 'stale';

export interface FeedVerdict {
  /** Symbols whose price is missing or stale this pass, as the incident names them. */
  bad: string[];
  /** Instrument id → since when it has been stale or missing, epoch ms. */
  staleSince: Record<string, number>;
  /** Symbols stale or missing for at least `pauseAfterMs`, with how long, in seconds. */
  lost: { symbol: string; seconds: number }[];
  /** Whether the feed gave a fresh price this pass. */
  feedLive: boolean;
  /** Each symbol in `bad` with why (N328). */
  problems: { symbol: string; reason: PriceProblem }[];
  /**
   * Subscribed but silent (N328): the feed is answering and other prices move,
   * but this symbol has had no new trade or quote for longer than the
   * threshold. Not stale under N276, so orders still go; reported on its own.
   */
  silent: { symbol: string; seconds: number }[];
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
  const problems: FeedVerdict['problems'] = [];
  const silent: FeedVerdict['silent'] = [];
  const staleSince: Record<string, number> = {};
  const lost: FeedVerdict['lost'] = [];
  for (const p of input.prices) {
    const q = p.quote;
    let problem: string | undefined;
    let reason: PriceProblem | undefined;
    if (!q) {
      problem = `${p.symbol} (no price)`;
      reason = p.miss ?? 'no_price';
    }
    // Outside the session the last quote simply stands; that is not a feed problem.
    else if (q.marketOpen && quoteAgeSec(q, now) > staleDataSec) {
      if (!feedLive) {
        problem = p.symbol;
        reason = 'stale';
      } else silent.push({ symbol: p.symbol, seconds: Math.round(quoteAgeSec(q, now)) });
    }
    if (!problem || !reason) continue;
    bad.push(problem);
    problems.push({ symbol: p.symbol, reason });
    const since = input.staleSince[p.instrumentId] ?? t;
    staleSince[p.instrumentId] = since;
    if (t - since >= input.pauseAfterMs)
      lost.push({ symbol: p.symbol, seconds: Math.round((t - since) / 1000) });
  }
  return { bad, staleSince, lost, feedLive, problems, silent };
}

const list = (symbols: string[]) => symbols.join(', ');

/**
 * The price incident's wording (N328): each cause in its own words, so the
 * Orders page says whether Alpaca refused the requests, timed out, answered
 * without the symbol, or the prices are simply old.
 */
export function feedIncidentSummary(verdict: FeedVerdict, staleDataSec: number): string {
  const by = (r: PriceProblem) =>
    verdict.problems.filter((p) => p.reason === r).map((p) => p.symbol);
  const parts: string[] = [];
  const throttled = by('throttled');
  if (throttled.length > 0)
    parts.push(
      `Alpaca refused the price requests for ${list(throttled)} as over the key’s request limit`,
    );
  const timeout = by('timeout');
  if (timeout.length > 0) parts.push(`the feed did not answer in time for ${list(timeout)}`);
  const failed = by('error');
  if (failed.length > 0) parts.push(`the feed failed for ${list(failed)}`);
  const none = by('no_price');
  if (none.length > 0) parts.push(`no price for ${list(none)}`);
  const noReply = by('no_reply');
  if (noReply.length > 0)
    parts.push(`subscribed but silent: the feed answered but sent no price for ${list(noReply)}`);
  const stale = by('stale');
  if (stale.length > 0) parts.push(`prices older than ${staleDataSec} seconds for ${list(stale)}`);
  if (verdict.silent.length > 0) {
    const longest = Math.max(...verdict.silent.map((s) => s.seconds));
    parts.push(
      `subscribed but silent: the feed is answering but sent no new price for ${list(verdict.silent.map((s) => s.symbol))} for ${longest} seconds`,
    );
  }
  const text = parts.join('; ');
  const tail =
    verdict.problems.length > 0
      ? '; no new orders are sent until they are current.'
      : '; other prices are current, so orders still go.';
  const sentence = text.charAt(0).toUpperCase() + text.slice(1) + tail;
  return sentence.length <= 500 ? sentence : `${sentence.slice(0, 497)}…`;
}

/**
 * How old a price counts as for the pre-trade stale-data check: a quote the
 * feed gave this pass is current while the feed is live (N276).
 */
export function effectivePriceAgeSec(quote: Quote, now: Date, feedLive: boolean): number {
  return feedLive ? 0 : quoteAgeSec(quote, now);
}
