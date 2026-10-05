import {
  instrumentRoutingInfo,
  loadRouting,
  openCredential,
  type Routing,
  type Transaction,
} from '@tm/db';
import { resolveRoute, UnsupportedBarRequestError, type HistoricalDataProvider } from '@tm/domain';
import type { ProviderRegistry } from './providers';

/**
 * Historical bars through the tenant's routes (§9.2; ADR 0017): each
 * instrument resolves to its bars route, and that route's feed answers,
 * the fallback when the primary is off. Provider calls happen outside the
 * transaction that resolved them.
 */
export function createRoutedHistory(options: {
  /** Runs `fn` in the tenant's scope: the pass's transaction, or a short one. */
  inTenant: <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;
  userId: string;
  now: () => Date;
  providers: ProviderRegistry;
  privateKey: string | undefined;
}): HistoricalDataProvider {
  const sources = new Map<string, HistoricalDataProvider | undefined>();
  let routing: Routing | undefined;

  async function sourceFor(instrumentId: string, symbol: string) {
    return options.inTenant(async (tx) => {
      const info = await instrumentRoutingInfo(tx, instrumentId);
      if (!info) throw new UnsupportedBarRequestError(`${symbol} is not a known instrument`);
      routing ??= await loadRouting(tx);
      const route = resolveRoute(routing.routes, { ...info, dataType: 'bars' });
      const feedId = [route?.primaryFeedId, route?.fallbackFeedId].find(
        (id): id is string => !!id && routing?.feeds.get(id)?.isActive === true,
      );
      if (!feedId) {
        throw new UnsupportedBarRequestError(
          `No data feed gives bars for ${symbol}. Add a route in Settings › Data feeds.`,
        );
      }
      if (sources.has(feedId)) return sources.get(feedId);
      const feed = routing.feeds.get(feedId);
      const provider = feed ? options.providers[feed.provider] : undefined;
      let source: HistoricalDataProvider | undefined;
      if (feed && provider) {
        const credential =
          provider.needsCredential && feed.credentialRef
            ? await openCredential(tx, {
                userId: options.userId,
                id: feed.credentialRef,
                privateKey: options.privateKey,
              })
            : undefined;
        if (!provider.needsCredential || credential) {
          source = provider.history({ now: options.now, credential });
        }
      }
      sources.set(feedId, source);
      return source;
    });
  }

  return {
    id: 'routed',
    intervals: ['1h', '1d'],
    async getBars(request) {
      const source = await sourceFor(request.instrumentId, request.symbol);
      if (!source) {
        throw new UnsupportedBarRequestError(
          `The data feed for ${request.symbol} cannot give bars right now`,
        );
      }
      return source.getBars(request);
    },
  };
}
