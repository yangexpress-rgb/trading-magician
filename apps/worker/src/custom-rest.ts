import { createHash } from 'node:crypto';
import {
  CUSTOM_CACHE,
  readCachedBars,
  readCachedQuote,
  takeCustomFeedRequest,
  writeCache,
  type CustomFeedTestResult,
  type FeedCheckResult,
  type Transaction,
} from '@tm/db';
import {
  addDays,
  buildRequest,
  mapBars,
  mapQuote,
  MappingError,
  nyDate,
  quoteAgeSec,
  regularSession,
  UnsupportedBarRequestError,
  type Bar,
  type BarSeries,
  type CustomDailyBar,
  type CustomQuote,
  type CustomRestConfig,
  type HistoricalDataProvider,
  type LiveQuoteProvider,
  type Quote,
} from '@tm/domain';
import Decimal from 'decimal.js';
import {
  CustomFetchError,
  fetchJson,
  httpsTransport,
  redact,
  type Transport,
} from './custom-rest-transport';
import type { MarketDataProvider, ProviderContext } from './providers';

/**
 * Custom REST (JSON) feeds as a market-data provider (v1.2 N17; ADR 0041).
 * One generic adapter reads every such feed from its stored description:
 * daily bars and the latest quote, fetched by the worker, cached in the
 * database and counted against the feed's limits, which the database keeps
 * for every worker. Nothing here knows any vendor.
 */

export const CUSTOM_QUOTE_SOURCE = 'custom-rest';

export interface CustomRestProviderOptions {
  /** Tests and local checks only: in place of the guarded HTTPS client. */
  transport?: Transport | undefined;
}

type TenantRunner = <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;

interface FeedContext {
  feedId: string;
  userId: string;
  config: CustomRestConfig;
  apiKey: string | undefined;
  inTenant: TenantRunner;
  now: () => Date;
}

function feedContext(ctx: ProviderContext): FeedContext {
  const feed = ctx.feed;
  if (!feed?.config || !ctx.userId || !ctx.inTenant) {
    throw new Error('A custom feed needs its settings and its tenant');
  }
  const apiKey =
    ctx.credential?.provider === 'custom_rest' ? ctx.credential.fields.apiKey : undefined;
  if (feed.config.auth.type !== 'none' && !apiKey) {
    throw new Error('No API key is stored for this feed');
  }
  return {
    feedId: feed.id,
    userId: ctx.userId,
    config: feed.config,
    apiKey,
    inTenant: ctx.inTenant,
    now: ctx.now,
  };
}

/** One request, after the feed's limits allow it; refused requests are never sent. */
async function call(
  f: FeedContext,
  transport: Transport,
  which: 'bars' | 'quote',
  values: { symbol: string; from?: string; to?: string },
): Promise<{ body: unknown; url: string }> {
  const req = buildRequest(f.config, which, values, f.apiKey);
  const allowed = await f.inTenant((tx) =>
    takeCustomFeedRequest(tx, {
      userId: f.userId,
      feedId: f.feedId,
      now: f.now(),
      limits: f.config.limits,
    }),
  );
  if (!allowed.ok) throw new CustomFetchError('held_back', allowed.reason);
  const body = await fetchJson(
    transport,
    {
      url: req.url,
      headers: req.headers,
      timeoutMs: f.config.limits.timeoutMs,
      shownUrl: req.shownUrl,
    },
    f.apiKey,
  );
  return { body, url: req.shownUrl };
}

/** A provider date label as the regular session's bar; non-trading dates are dropped. */
export function toSessionBar(b: CustomDailyBar): Bar | undefined {
  const session = regularSession(b.date);
  if (!session) return undefined;
  return {
    start: session.open,
    end: session.close,
    open: new Decimal(b.open),
    high: new Decimal(b.high),
    low: new Decimal(b.low),
    close: new Decimal(b.close),
    volume: new Decimal(b.volume),
  };
}

function isSessionOpen(at: Date): boolean {
  const session = regularSession(nyDate(at));
  if (!session) return false;
  return at.getTime() >= Date.parse(session.open) && at.getTime() < Date.parse(session.close);
}

function toQuote(
  ref: { instrumentId: string; symbol: string },
  q: CustomQuote,
  fetchedAt: Date,
  now: Date,
): Quote {
  const last = new Decimal(q.last);
  return {
    instrumentId: ref.instrumentId,
    symbol: ref.symbol,
    bid: q.bid ? new Decimal(q.bid) : last,
    ask: q.ask ? new Decimal(q.ask) : last,
    last,
    size: new Decimal(1),
    // Without a mapped time, the price is as old as the fetch.
    at: q.at ?? fetchedAt.toISOString(),
    receivedAt: now.toISOString(),
    source: CUSTOM_QUOTE_SOURCE,
    marketOpen: isSessionOpen(now),
  };
}

async function dailyBars(
  f: FeedContext,
  transport: Transport,
  symbol: string,
  from: string,
  to: string,
): Promise<CustomDailyBar[]> {
  const now = f.now();
  const reachesToday = to >= nyDate(now);
  const freshSince = new Date(
    now.getTime() - (reachesToday ? CUSTOM_CACHE.openBarsMs : CUSTOM_CACHE.closedBarsMs),
  );
  const cached = await f.inTenant((tx) =>
    readCachedBars(tx, { feedId: f.feedId, symbol, from, to, freshSince }),
  );
  if (cached) return cached.bars.filter((b) => b.date >= from && b.date <= to);
  const { body } = await call(f, transport, 'bars', { symbol, from, to });
  const bars = mapBars(body, f.config.bars);
  await f.inTenant((tx) =>
    writeCache(tx, {
      userId: f.userId,
      feedId: f.feedId,
      kind: 'bars',
      symbol,
      from,
      to,
      payload: bars,
      now,
    }),
  );
  return bars.filter((b) => b.date >= from && b.date <= to);
}

async function latest(
  f: FeedContext,
  transport: Transport,
  symbol: string,
): Promise<{ quote: CustomQuote; fetchedAt: Date }> {
  const now = f.now();
  const cached = await f.inTenant((tx) =>
    readCachedQuote(tx, {
      feedId: f.feedId,
      symbol,
      freshSince: new Date(now.getTime() - CUSTOM_CACHE.quoteMs),
    }),
  );
  if (cached) return cached;
  const { body } = await call(f, transport, 'quote', { symbol });
  const quote = mapQuote(body, f.config.quote);
  await f.inTenant((tx) =>
    writeCache(tx, {
      userId: f.userId,
      feedId: f.feedId,
      kind: 'quote',
      symbol,
      payload: quote,
      now,
    }),
  );
  return { quote, fetchedAt: now };
}

/** A failure in words for the feed's card, without the key. */
export function failureText(error: unknown, apiKey?: string): string {
  if (error instanceof CustomFetchError || error instanceof MappingError) {
    return redact(error.message, apiKey);
  }
  if (error instanceof UnsupportedBarRequestError) return error.message;
  return 'The provider could not be reached';
}

export function customRestProvider(options: CustomRestProviderOptions = {}): MarketDataProvider {
  const transport = options.transport ?? httpsTransport;
  return {
    // Its key depends on its description: callers open the feed's key when it has one.
    needsCredential: false,
    quotes: (ctx): LiveQuoteProvider => {
      const f = feedContext(ctx);
      return {
        id: CUSTOM_QUOTE_SOURCE,
        async latestQuote(ref) {
          const { quote, fetchedAt } = await latest(f, transport, ref.symbol);
          return toQuote(ref, quote, fetchedAt, f.now());
        },
      };
    },
    history: (ctx): HistoricalDataProvider => {
      const f = feedContext(ctx);
      const host = new URL(f.config.baseUrl).hostname;
      return {
        id: `custom-${f.feedId.slice(0, 8)}`,
        intervals: ['1d'],
        async getBars(req): Promise<BarSeries> {
          if (req.interval !== '1d') {
            throw new UnsupportedBarRequestError(
              `This custom feed gives daily bars only, not ${req.interval}`,
            );
          }
          if (req.from > req.to) {
            throw new UnsupportedBarRequestError('The start date is after the end date');
          }
          const raw = await dailyBars(f, transport, req.symbol, req.from, req.to);
          const cutoff = f.now().getTime();
          const bars = raw
            .map(toSessionBar)
            .filter((b): b is Bar => !!b && Date.parse(b.end) <= cutoff);
          const digest = createHash('sha256')
            .update(JSON.stringify([req.symbol, f.config.barsUrl, raw]))
            .digest('hex')
            .slice(0, 16);
          const warnings = [
            `Daily bars from ${host} as that provider gives them; the app’s split and dividend setting is not applied`,
          ];
          if (req.session === 'extended')
            warnings.push('Custom feed bars cover the regular session');
          return { bars, dataVersion: `custom-${digest}`, warnings };
        },
      };
    },
    /** The minute-by-minute check: the latest quote of the test symbol, read with the mapping. */
    check: async (ctx): Promise<FeedCheckResult> => {
      let f: FeedContext;
      try {
        f = feedContext(ctx);
      } catch (e) {
        return { ok: false, entitlement: 'unknown', error: (e as Error).message };
      }
      try {
        const symbol = f.config.testSymbol;
        const { body } = await call(f, transport, 'quote', { symbol });
        const quote = mapQuote(body, f.config.quote);
        const now = f.now();
        await f.inTenant((tx) =>
          writeCache(tx, {
            userId: f.userId,
            feedId: f.feedId,
            kind: 'quote',
            symbol,
            payload: quote,
            now,
          }),
        );
        // Real time only when the provider stamps its prices and they are current.
        const realtime =
          quote.at !== null && isSessionOpen(now)
            ? quoteAgeSec({ at: quote.at }, now) <= 60
            : undefined;
        return {
          ok: true,
          entitlement: 'entitled',
          ...(realtime === undefined ? {} : { realtime }),
        };
      } catch (e) {
        const status = e instanceof CustomFetchError ? e.status : undefined;
        return {
          ok: false,
          entitlement: status === 401 || status === 403 ? 'not_entitled' : 'unknown',
          error: failureText(e, f.apiKey).slice(0, 300),
        };
      }
    },
  };
}

/**
 * "Test" before saving (ADR 0041): one daily-bars request for the last month
 * and one quote request, both read with the mapping. Not counted against a
 * feed (there is none yet) and not cached; the web app limits how often a
 * person can press it.
 */
export async function runCustomTest(input: {
  config: CustomRestConfig;
  apiKey: string | undefined;
  symbol: string;
  now: Date;
  transport?: Transport | undefined;
}): Promise<{ ok: true; result: CustomFeedTestResult } | { ok: false; message: string }> {
  const transport = input.transport ?? httpsTransport;
  const { config, apiKey, symbol } = input;
  if (config.auth.type !== 'none' && !apiKey) {
    return { ok: false, message: 'No API key is stored for this feed' };
  }
  const to = nyDate(input.now);
  const from = addDays(to, -31);
  const fetch = async (which: 'bars' | 'quote') => {
    const req = buildRequest(config, which, { symbol, from, to }, apiKey);
    const body = await fetchJson(
      transport,
      {
        url: req.url,
        headers: req.headers,
        timeoutMs: config.limits.timeoutMs,
        shownUrl: req.shownUrl,
      },
      apiKey,
    );
    return { body, url: req.shownUrl };
  };
  let step = 'Daily bars';
  try {
    const bars = await fetch('bars');
    const mapped = mapBars(bars.body, config.bars).filter((b) => b.date >= from && b.date <= to);
    if (mapped.length === 0) {
      return {
        ok: false,
        message: `Daily bars: the answer had no bars for ${symbol} between ${from} and ${to}`,
      };
    }
    step = 'Quote';
    const quoted = await fetch('quote');
    const quote = mapQuote(quoted.body, config.quote);
    return {
      ok: true,
      result: {
        symbol,
        bars: {
          count: mapped.length,
          first: mapped[0]?.date ?? null,
          last: mapped.at(-1)?.date ?? null,
          sample: mapped.slice(-5),
          url: bars.url,
        },
        quote: { ...quote, url: quoted.url },
      },
    };
  } catch (e) {
    const text = failureText(e, apiKey);
    return { ok: false, message: e instanceof MappingError ? text : `${step}: ${text}` };
  }
}
