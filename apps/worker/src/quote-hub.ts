import type { LiveQuoteProvider, Quote, QuoteRequest } from '@tm/domain';
import type { Logger } from 'pino';
import { withTimeout } from './providers';

/**
 * Why a quote ask came back without a price (N326):
 * - `throttled`: the feed refused the request as over its limit (Alpaca 429);
 * - `timeout`: the feed did not answer in time;
 * - `error`: the feed failed some other way;
 * - `no_reply`: the feed answered, but left this symbol out.
 */
export type MissReason = 'throttled' | 'timeout' | 'error' | 'no_reply';

export interface HubEntry {
  quote?: Quote | undefined;
  reason?: MissReason | undefined;
  /** The pass time it was fetched at, epoch ms. */
  at: number;
}

/** Feed requests kept by symbol: what was asked, why it failed, when it last worked. */
export interface HubTrail {
  noteAsk(symbol: string, quote: Quote | undefined, reason?: MissReason): void;
  noteBatchFailure(reason: MissReason): void;
}

const QUOTE_TIMEOUT_MS = 5_000;

export function missReasonOf(error: unknown): MissReason {
  const e = error as Error | undefined;
  if (e?.name === 'AlpacaRateLimitError') return 'throttled';
  if (e?.name === 'AlpacaUnavailableError' && /in time/.test(e.message)) return 'timeout';
  if (e && /timed out/.test(e.message)) return 'timeout';
  return 'error';
}

/**
 * One process-wide place the runtimes get live prices from (N326). Every
 * running strategy used to ask its feed for its own prices on each of its
 * passes, so 18 strategies passing every 5 seconds sent about 216 requests a
 * minute through one Alpaca key whose limit is 200; Alpaca refused the excess
 * and those strategies saw "no price".
 *
 * Now a feed is asked at most once per `freshMs` for every symbol any runtime
 * has wanted lately, in as few requests as the feed allows, and each runtime
 * reads its prices from what came back. When the feed fails, every wanted
 * symbol is asked again on the next request, and the set that came back is
 * logged when the feed recovers, so no symbol is left out after an outage.
 */
export class QuoteHub {
  private readonly freshMs: number;
  private readonly wantedForMs: number;
  private readonly entries = new Map<string, Map<string, HubEntry>>();
  private readonly wanted = new Map<string, Map<string, { ref: QuoteRequest; at: number }>>();
  private readonly inflight = new Map<string, Promise<void>>();
  private readonly failing = new Map<string, { since: number; reason: MissReason }>();
  private readonly logger: Pick<Logger, 'info' | 'warn'> | undefined;
  private readonly trail: HubTrail | undefined;

  constructor(
    options: {
      /** A feed's prices are reused for this long; then the next ask goes to the feed. */
      freshMs?: number;
      /** A symbol no runtime has asked for in this long is dropped from the batch. */
      wantedForMs?: number;
      logger?: Pick<Logger, 'info' | 'warn'> | undefined;
      trail?: HubTrail | undefined;
    } = {},
  ) {
    this.freshMs = options.freshMs ?? 2_000;
    this.wantedForMs = options.wantedForMs ?? 30_000;
    this.logger = options.logger;
    this.trail = options.trail;
  }

  /** The latest entry for an instrument on a feed, fresh or not. */
  read(feedId: string, instrumentId: string): HubEntry | undefined {
    return this.entries.get(feedId)?.get(instrumentId);
  }

  /** The symbols a feed (or every feed) is asked for together now (tests and logs). */
  wantedSymbols(feedId?: string): string[] {
    const feeds = feedId ? [this.wanted.get(feedId)] : [...this.wanted.values()];
    const symbols = new Set<string>();
    for (const f of feeds) for (const w of f?.values() ?? []) symbols.add(w.ref.symbol);
    return [...symbols].sort();
  }

  private fresh(entry: HubEntry | undefined, nowMs: number): boolean {
    // A clock that went back (tests) is never served an entry from its future.
    return !!entry && entry.at <= nowMs && nowMs - entry.at < this.freshMs;
  }

  /** Makes these instruments' entries fresh, asking the feed only for what is not. */
  async get(
    feedId: string,
    source: LiveQuoteProvider,
    refs: readonly QuoteRequest[],
    nowMs: number,
  ): Promise<void> {
    let wanted = this.wanted.get(feedId);
    if (!wanted) {
      wanted = new Map();
      this.wanted.set(feedId, wanted);
    }
    for (const ref of refs) wanted.set(ref.instrumentId, { ref, at: nowMs });
    for (const [id, w] of wanted) if (nowMs - w.at > this.wantedForMs) wanted.delete(id);

    const entries = this.entries.get(feedId) ?? new Map<string, HubEntry>();
    this.entries.set(feedId, entries);
    const stale = () => refs.filter((r) => !this.fresh(entries.get(r.instrumentId), nowMs));
    if (stale().length === 0) return;
    const running = this.inflight.get(feedId);
    if (running) {
      await running;
      if (stale().length === 0) return;
    }
    // Every symbol wanted lately goes in the same request, so the next runtime's pass is served.
    const ask = [...wanted.values()]
      .map((w) => w.ref)
      .filter((r) => !this.fresh(entries.get(r.instrumentId), nowMs));
    const fetch = this.fetch(feedId, source, ask, nowMs, entries).finally(() => {
      if (this.inflight.get(feedId) === fetch) this.inflight.delete(feedId);
    });
    this.inflight.set(feedId, fetch);
    await fetch;
  }

  private async fetch(
    feedId: string,
    source: LiveQuoteProvider,
    refs: readonly QuoteRequest[],
    nowMs: number,
    entries: Map<string, HubEntry>,
  ): Promise<void> {
    if (refs.length === 0) return;
    let got = 0;
    let failure: MissReason | undefined;
    const store = (ref: QuoteRequest, quote: Quote | undefined, reason?: MissReason) => {
      entries.set(ref.instrumentId, quote ? { quote, at: nowMs } : { reason, at: nowMs });
      this.trail?.noteAsk(ref.symbol, quote, quote ? undefined : reason);
      if (quote) got++;
    };
    if (source.latestQuotes && refs.length >= 2) {
      try {
        const all = await withTimeout(source.latestQuotes(refs), QUOTE_TIMEOUT_MS, 'quotes');
        for (const ref of refs) store(ref, all.get(ref.instrumentId), 'no_reply');
      } catch (error) {
        failure = missReasonOf(error);
        this.trail?.noteBatchFailure(failure);
        for (const ref of refs) store(ref, undefined, failure);
      }
    } else {
      await Promise.all(
        refs.map(async (ref) => {
          try {
            const q = await withTimeout(source.latestQuote(ref), QUOTE_TIMEOUT_MS, 'quote');
            store(ref, q, 'no_reply');
          } catch (error) {
            failure = missReasonOf(error);
            store(ref, undefined, failure);
          }
        }),
      );
    }
    const down = this.failing.get(feedId);
    if (got === 0 && failure) {
      if (!down) {
        this.failing.set(feedId, { since: nowMs, reason: failure });
        this.logger?.warn(
          {
            event: 'quotes.feed_failed',
            feedId,
            reason: failure,
            symbols: refs.map((r) => r.symbol),
          },
          'price feed failed; every wanted symbol is asked again on the next request',
        );
      }
    } else if (down && got > 0) {
      this.failing.delete(feedId);
      // The whole wanted set went in this request: log what came back.
      this.logger?.info(
        {
          event: 'quotes.feed_restored',
          feedId,
          downForMs: nowMs - down.since,
          reason: down.reason,
          restored: refs.filter((r) => entries.get(r.instrumentId)?.quote).map((r) => r.symbol),
          stillMissing: refs
            .filter((r) => !entries.get(r.instrumentId)?.quote)
            .map((r) => r.symbol),
        },
        'price feed answering again; wanted symbols asked again',
      );
    }
  }
}
