import {
  applyFailoverStep,
  instrumentRoutingInfo,
  openCredential,
  type OpenedCredential,
  type Routing,
  type RoutingFeed,
  type Transaction,
  type CredentialKey,
  type FeedScope,
  type TenantRunner,
} from '@tm/db';
import {
  FAILOVER,
  failoverStep,
  quoteAgeSec,
  resolveRoute,
  type LiveQuoteProvider,
  type Quote,
  type QuoteRequest,
  type RouteLike,
} from '@tm/domain';
import type { Logger } from 'pino';
import { withTimeout, type ProviderRegistry } from './providers';

const QUOTE_TIMEOUT_MS = 5_000;

/**
 * What the runtimes' quote asks got, per symbol, since the last drain.
 * A failed ask used to vanish into "no price" with nothing logged; the worker
 * now logs this once a minute so a missing price can be traced to its cause.
 */
interface SymbolTrail {
  asked: number;
  failed: number;
  /** Why the last failed ask failed: the error's name, or 'missing' when the reply left it out. */
  lastError?: string;
  lastFailedAt?: number;
  /** When an ask last came back with a price, epoch ms. */
  lastOkAt?: number;
  /** The newest trade or quote time a reply carried. */
  lastQuoteAt?: string;
}

let trail = new Map<string, SymbolTrail>();
/** Kept across drains, so a symbol that keeps failing still shows when it last worked. */
const lastOk = new Map<string, number>();

function noteAsk(symbol: string, quote: Quote | undefined, error?: string): void {
  const t = trail.get(symbol) ?? { asked: 0, failed: 0 };
  t.asked++;
  const now = Date.now();
  if (quote) {
    t.lastOkAt = now;
    lastOk.set(symbol, now);
    if (!t.lastQuoteAt || quote.at > t.lastQuoteAt) t.lastQuoteAt = quote.at;
  } else {
    t.failed++;
    t.lastError = error ?? 'missing';
    t.lastFailedAt = now;
  }
  trail.set(symbol, t);
}

const errorLabel = (error: unknown) => {
  const e = error as Error;
  if (e?.name === 'Error' && /timed out/.test(e.message)) return 'Timeout';
  return e?.name || 'Error';
};

/** Batched asks that failed as a whole since the last drain, by error. */
let batchFailures = new Map<string, number>();

export function drainBatchFailures(): Record<string, number> {
  const out = Object.fromEntries(batchFailures);
  batchFailures = new Map();
  return out;
}

export interface QuoteTrailEntry {
  symbol: string;
  asked: number;
  failed: number;
  lastError: string | null;
  lastFailedAt: string | null;
  lastOkAt: string | null;
  lastQuoteAt: string | null;
}

/** The symbols asked for since the last call, failures first, and starts afresh. */
export function drainQuoteTrail(): QuoteTrailEntry[] {
  const iso = (ms: number | undefined) => (ms === undefined ? null : new Date(ms).toISOString());
  const out = [...trail].map(([symbol, t]) => ({
    symbol,
    asked: t.asked,
    failed: t.failed,
    lastError: t.lastError ?? null,
    lastFailedAt: iso(t.lastFailedAt),
    lastOkAt: iso(t.lastOkAt ?? lastOk.get(symbol)),
    lastQuoteAt: t.lastQuoteAt ?? null,
  }));
  trail = new Map();
  return out.sort((a, b) => b.failed - a.failed || a.symbol.localeCompare(b.symbol));
}

export interface RoutedQuotes extends LiveQuoteProvider {
  /** Fetches these instruments' quotes for the pass in as few requests as the feeds allow. */
  prefetch(refs: readonly QuoteRequest[]): Promise<void>;
}

export interface FeedAsker {
  sourceFor(feed: RoutingFeed): Promise<LiveQuoteProvider | undefined>;
  /** One feed's quote for an instrument, asked once per pass and stamped with the feed. */
  ask(feedId: string | null, ref: QuoteRequest): Promise<Quote | undefined>;
  /** Asks one feed for many instruments in one request where it can (ADR 0087). */
  prefetchFrom(feedId: string, refs: readonly QuoteRequest[]): Promise<void>;
  /** Whether this feed's quote for the instrument is already asked for this pass. */
  has(feedId: string, instrumentId: string): boolean;
}

/**
 * Asks named feeds for quotes during one pass: opens each feed's source once
 * (with its key, in the tenant that owns it), times requests out, and stamps
 * every quote with the feed that answered (ADR 0108).
 */
export function createFeedAsker(options: {
  tx: Transaction;
  userId: string;
  now: Date;
  feeds: Routing['feeds'];
  providers: ProviderRegistry;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'warn'>;
  scope?: FeedScope | undefined;
}): FeedAsker {
  const { tx, now } = options;
  const userId = options.scope?.userId ?? options.userId;
  const inFeeds: TenantRunner = options.scope?.inTenant ?? ((fn) => fn(tx));
  const at = () => now;
  const sources = new Map<string, LiveQuoteProvider | undefined>();
  const asked = new Map<string, Promise<Quote | undefined>>();
  const stamp = (feedId: string, q: Quote | undefined) => (q ? { ...q, feedId } : undefined);

  async function sourceFor(feed: RoutingFeed): Promise<LiveQuoteProvider | undefined> {
    if (sources.has(feed.id)) return sources.get(feed.id);
    let source: LiveQuoteProvider | undefined;
    const provider = options.providers[feed.provider];
    try {
      if (provider) {
        let credential: OpenedCredential | undefined;
        // A custom feed has a key only when its description signs in with one (ADR 0041).
        if (provider.needsCredential || feed.credentialRef) {
          if (!feed.credentialRef) throw new Error('no stored key');
          const ref = feed.credentialRef;
          credential = await inFeeds((t) =>
            openCredential(t, { userId, id: ref, privateKey: options.privateKey }),
          );
        }
        source = provider.quotes({
          now: at,
          credential,
          feed: { id: feed.id, config: feed.config },
          userId,
          inTenant: inFeeds,
        });
      }
    } catch (error) {
      options.logger.warn(
        { feedId: feed.id, err: { name: (error as Error).name } },
        'feed could not be opened',
      );
    }
    sources.set(feed.id, source);
    return source;
  }

  function ask(feedId: string | null, ref: QuoteRequest): Promise<Quote | undefined> {
    const key = `${feedId ?? ''}:${ref.instrumentId}`;
    let pending = asked.get(key);
    if (!pending) {
      pending = askFeed(feedId, ref);
      asked.set(key, pending);
    }
    return pending;
  }

  async function askFeed(feedId: string | null, ref: QuoteRequest): Promise<Quote | undefined> {
    const feed = feedId ? options.feeds.get(feedId) : undefined;
    if (!feed?.isActive) return undefined;
    const source = await sourceFor(feed);
    if (!source) return undefined;
    try {
      const quote = stamp(
        feed.id,
        await withTimeout(source.latestQuote(ref), QUOTE_TIMEOUT_MS, 'quote'),
      );
      noteAsk(ref.symbol, quote);
      return quote;
    } catch (error) {
      noteAsk(ref.symbol, undefined, errorLabel(error));
      return undefined;
    }
  }

  async function prefetchFrom(feedId: string, list: readonly QuoteRequest[]): Promise<void> {
    const feed = options.feeds.get(feedId);
    const source = feed?.isActive ? await sourceFor(feed) : undefined;
    if (!source?.latestQuotes || list.length < 2) return;
    const all = withTimeout(source.latestQuotes(list), QUOTE_TIMEOUT_MS, 'quotes').catch(
      (error: unknown) => {
        const label = errorLabel(error);
        batchFailures.set(label, (batchFailures.get(label) ?? 0) + 1);
        return undefined;
      },
    );
    for (const ref of list) {
      // A batch that fails leaves each instrument to be asked on its own.
      asked.set(
        `${feedId}:${ref.instrumentId}`,
        all.then((m) => {
          if (!m) return askFeed(feedId, ref);
          const quote = stamp(feedId, m.get(ref.instrumentId));
          noteAsk(ref.symbol, quote);
          return quote;
        }),
      );
    }
  }

  return {
    sourceFor,
    ask,
    prefetchFrom,
    has: (feedId, instrumentId) => asked.has(`${feedId}:${instrumentId}`),
  };
}

/**
 * Prices for one pass, through the tenant's routes (§9.2; ADR 0016). Each
 * instrument resolves to a route; the route's primary feed answers unless it
 * is off, silent or stale, in which case the route fails over to its
 * fallback, and back once the primary has recovered. Each route is decided
 * once per pass, so every leg of a pass sees prices from the same feed.
 */
export function createRoutedQuotes(options: {
  tx: Transaction;
  userId: string;
  now: Date;
  routing: Routing;
  providers: ProviderRegistry;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'warn'>;
  /**
   * Whose routes and feeds these are when they are not the tenant's own: the
   * sharing admin's (N237, ADR 0084). Their keys open, and their routes fail
   * over, in the admin's tenant, in transactions of their own.
   */
  feeds?: FeedScope | undefined;
}): RoutedQuotes {
  const { tx, now, routing } = options;
  const userId = options.feeds?.userId ?? options.userId;
  const inFeeds: TenantRunner = options.feeds?.inTenant ?? ((fn) => fn(tx));
  const decided = new Map<string, Promise<RouteLike>>();
  const { ask, has, prefetchFrom } = createFeedAsker({
    tx,
    userId: options.userId,
    now,
    feeds: routing.feeds,
    providers: options.providers,
    privateKey: options.privateKey,
    logger: options.logger,
    scope: options.feeds,
  });

  const healthy = (q: Quote | undefined) =>
    q !== undefined && quoteAgeSec(q, now) <= FAILOVER.staleSec;

  function decide(route: RouteLike, ref: QuoteRequest): Promise<RouteLike> {
    let pending = decided.get(route.id);
    if (!pending) {
      pending = (async () => {
        // Only routes with a fallback need the primary probed while failed over.
        if (!route.fallbackFeedId) return route;
        const primaryQuote = await ask(route.primaryFeedId, ref);
        const step = failoverStep(route, healthy(primaryQuote), now);
        if (step.kind === 'stay') return route;
        await inFeeds((t) =>
          applyFailoverStep(t, { userId, route, step, now, feeds: routing.feeds }),
        );
        switch (step.kind) {
          case 'fail_over':
            return { ...route, activeSource: 'fallback', primaryOkSince: null };
          case 'switch_back':
            return { ...route, activeSource: 'primary', primaryOkSince: null };
          case 'primary_recovering':
            return { ...route, primaryOkSince: step.since };
          case 'primary_relapsed':
            return { ...route, primaryOkSince: null };
        }
      })();
      decided.set(route.id, pending);
    }
    return pending;
  }

  /** The feed that answers an instrument this pass, or undefined without a route. */
  async function feedOf(ref: QuoteRequest): Promise<string | null | undefined> {
    const info = await instrumentRoutingInfo(tx, ref.instrumentId);
    if (!info) return undefined;
    const route = resolveRoute(routing.routes, { ...info, dataType: 'quotes' });
    if (!route) return undefined;
    const current = await decide(route, ref);
    return current.activeSource === 'fallback' ? current.fallbackFeedId : current.primaryFeedId;
  }

  return {
    id: 'routed',
    async latestQuote(ref) {
      const feedId = await feedOf(ref);
      if (feedId === undefined) return undefined;
      return ask(feedId, ref);
    },
    /**
     * Asks each feed for many instruments at once where it can (ADR 0087), so
     * the pass's later `latestQuote` calls are answered from what came back. A
     * runtime holding ten stocks then sends one request a pass, not ten.
     */
    async prefetch(refs) {
      const byFeed = new Map<string, QuoteRequest[]>();
      for (const ref of refs) {
        const feedId = await feedOf(ref);
        if (!feedId || has(feedId, ref.instrumentId)) continue;
        byFeed.set(feedId, [...(byFeed.get(feedId) ?? []), ref]);
      }
      for (const [feedId, list] of byFeed) await prefetchFrom(feedId, list);
    },
  };
}
