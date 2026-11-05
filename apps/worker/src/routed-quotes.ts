import {
  applyFailoverStep,
  instrumentRoutingInfo,
  openCredential,
  type OpenedCredential,
  type Routing,
  type RoutingFeed,
  type Transaction,
  type CredentialKey,
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
}): LiveQuoteProvider {
  const { tx, userId, now, routing } = options;
  const at = () => now;
  const sources = new Map<string, LiveQuoteProvider | undefined>();
  const decided = new Map<string, Promise<RouteLike>>();
  const asked = new Map<string, Promise<Quote | undefined>>();

  async function sourceFor(feed: RoutingFeed): Promise<LiveQuoteProvider | undefined> {
    if (sources.has(feed.id)) return sources.get(feed.id);
    let source: LiveQuoteProvider | undefined;
    const provider = options.providers[feed.provider];
    try {
      if (provider) {
        let credential: OpenedCredential | undefined;
        if (provider.needsCredential) {
          if (!feed.credentialRef) throw new Error('no stored key');
          credential = await openCredential(tx, {
            userId,
            id: feed.credentialRef,
            privateKey: options.privateKey,
          });
        }
        source = provider.quotes({ now: at, credential });
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
    const feed = feedId ? routing.feeds.get(feedId) : undefined;
    if (!feed?.isActive) return undefined;
    const source = await sourceFor(feed);
    if (!source) return undefined;
    try {
      return await withTimeout(source.latestQuote(ref), QUOTE_TIMEOUT_MS, 'quote');
    } catch {
      return undefined;
    }
  }

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
        await applyFailoverStep(tx, { userId, route, step, now, feeds: routing.feeds });
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

  return {
    id: 'routed',
    async latestQuote(ref) {
      const info = await instrumentRoutingInfo(tx, ref.instrumentId);
      if (!info) return undefined;
      const route = resolveRoute(routing.routes, { ...info, dataType: 'quotes' });
      if (!route) return undefined;
      const current = await decide(route, ref);
      return ask(
        current.activeSource === 'fallback' ? current.fallbackFeedId : current.primaryFeedId,
        ref,
      );
    },
  };
}
