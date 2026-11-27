import {
  OPTIONS_DEFAULTS,
  quoteMid,
  regularSessionOpenAt,
  type BrokerAdapter,
  type OptionQuote,
  type Quote,
  type QuoteRequest,
} from '@tm/domain';
import Decimal from 'decimal.js';
import type { ChainStep } from '@tm/domain';
import type { RoutedQuotes } from '../routed-quotes';
import type { MissReason } from '../quote-hub';

/**
 * Options quotes (options brief v0.2 §8.2, ADR 0123): their own feed, from
 * the run's broker account, asked at most every 15 seconds and only for
 * contracts the run holds or is ordering. They use the options share of the
 * Alpaca key's budget, so an options throttle can never take an equity
 * quote's slot. Stock and ETF quotes go to the run's feeds exactly as before.
 */

interface Entry {
  quote: OptionQuote;
  fetchedAt: number;
}

/** Shared by every runtime pass, keyed by OCC symbol. */
export class OptionQuoteCache {
  private readonly map = new Map<string, Entry>();
  get(symbol: string): Entry | undefined {
    return this.map.get(symbol);
  }
  set(symbol: string, quote: OptionQuote, at: number) {
    this.map.set(symbol, { quote, fetchedAt: at });
  }
}

/** An options quote as the runtime's quote: last is the mid (§7.1). */
export function asQuote(ref: QuoteRequest, q: OptionQuote, now: Date): Quote | undefined {
  const mid = quoteMid(q);
  if (!mid) return undefined;
  return {
    instrumentId: ref.instrumentId,
    symbol: ref.symbol,
    bid: new Decimal(q.bid),
    ask: new Decimal(q.ask),
    last: mid,
    size: new Decimal(1),
    at: q.at,
    receivedAt: now.toISOString(),
    source: 'alpaca-options',
    marketOpen: regularSessionOpenAt(now.getTime()),
  };
}

type PassQuotes = RoutedQuotes & { readonly step?: ChainStep | undefined };

export interface OptionQuoteSource extends RoutedQuotes {
  readonly step: ChainStep | undefined;
  /** Points the source at the run's broker account, once the pass has opened it. */
  attach(broker: BrokerAdapter, accountId: string): void;
  /** The contract's quote asked of the broker now, past the 15-second cadence (§8.2). */
  optionQuote(symbol: string): Promise<OptionQuote | undefined>;
}

/**
 * Wraps a pass's quotes: an option contract (`isOption` gives its OCC symbol)
 * is answered from the broker on the options budget; everything else goes to
 * `base` unchanged.
 */
export function withOptionQuotes(
  base: PassQuotes,
  options: {
    cache: OptionQuoteCache;
    now: Date;
    isOption: (instrumentId: string) => boolean;
    everyMs?: number;
  },
): OptionQuoteSource {
  const { cache, now } = options;
  const every = options.everyMs ?? OPTIONS_DEFAULTS.quoteEveryMs;
  let broker: BrokerAdapter | undefined;
  let account: string | undefined;
  const misses = new Map<string, MissReason>();
  const t = now.getTime();

  const fetchSymbols = async (symbols: readonly string[]) => {
    if (!broker?.optionQuotes || !account || symbols.length === 0) return;
    try {
      const got = await broker.optionQuotes(account, symbols);
      for (const [s, q] of got) cache.set(s, q, t);
    } catch {
      // Budget full or broker unavailable (O221): the cached quote, if any, ages.
      for (const s of symbols) misses.set(s, 'throttled');
    }
  };
  const due = (symbol: string) => {
    const e = cache.get(symbol);
    return !e || t - e.fetchedAt >= every || t < e.fetchedAt;
  };
  const answer = async (ref: QuoteRequest, fresh: boolean) => {
    if (fresh || due(ref.symbol)) await fetchSymbols([ref.symbol]);
    const e = cache.get(ref.symbol);
    return e ? asQuote(ref, e.quote, now) : undefined;
  };

  return {
    id: base.id,
    get step() {
      return base.step;
    },
    attach(b, accountId) {
      broker = b;
      account = accountId;
    },
    async optionQuote(symbol) {
      await fetchSymbols([symbol]);
      return cache.get(symbol)?.quote;
    },
    async latestQuote(ref) {
      return options.isOption(ref.instrumentId) ? answer(ref, false) : base.latestQuote(ref);
    },
    async freshQuote(ref) {
      if (options.isOption(ref.instrumentId)) return answer(ref, true);
      return base.freshQuote ? base.freshQuote(ref) : base.latestQuote(ref);
    },
    async latestQuotes(refs) {
      const equity = refs.filter((r) => !options.isOption(r.instrumentId));
      const out = base.latestQuotes ? await base.latestQuotes(equity) : new Map<string, Quote>();
      const opts = refs.filter((r) => options.isOption(r.instrumentId));
      await fetchSymbols(opts.filter((r) => due(r.symbol)).map((r) => r.symbol));
      for (const r of opts) {
        const e = cache.get(r.symbol);
        const q = e ? asQuote(r, e.quote, now) : undefined;
        if (q) out.set(r.instrumentId, q);
      }
      return out;
    },
    async prefetch(refs) {
      // Contract symbols never go to a stock feed: one bad symbol can fail a whole batch.
      await base.prefetch(refs.filter((r) => !options.isOption(r.instrumentId)));
      const opts = refs.filter((r) => options.isOption(r.instrumentId) && due(r.symbol));
      await fetchSymbols(opts.map((r) => r.symbol));
    },
    missReason(instrumentId) {
      return base.missReason(instrumentId);
    },
  };
}
