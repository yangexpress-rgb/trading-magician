import {
  instrumentRoutingInfo,
  loadRouting,
  openCredential,
  type Routing,
  type Transaction,
  type CredentialKey,
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
  privateKey: CredentialKey | undefined;
  /** Told which feed answers each instrument, e.g. to name the source on a chart. */
  onFeed?: (instrumentId: string, feed: { id: string; name: string; provider: string }) => void;
}): HistoricalDataProvider {
  const sources = new Map<string, HistoricalDataProvider | undefined>();
  let routing: Routing | undefined;

  type Candidate = { feedId: string; name: string; provider: string };

  /** The route's active feeds in order: the primary, then its fallback. */
  async function candidatesFor(instrumentId: string, symbol: string): Promise<Candidate[]> {
    return options.inTenant(async (tx) => {
      const info = await instrumentRoutingInfo(tx, instrumentId);
      if (!info) throw new UnsupportedBarRequestError(`${symbol} is not a known instrument`);
      routing ??= await loadRouting(tx);
      const route = resolveRoute(routing.routes, { ...info, dataType: 'bars' });
      const ids = [route?.primaryFeedId, route?.fallbackFeedId].filter(
        (id): id is string => !!id && routing?.feeds.get(id)?.isActive === true,
      );
      if (ids.length === 0) {
        throw new UnsupportedBarRequestError(
          `No data feed gives bars for ${symbol}. Add a route in Settings › Data feeds.`,
        );
      }
      return ids.map((id) => {
        const f = routing?.feeds.get(id);
        return { feedId: id, name: f?.name ?? 'a feed', provider: f?.provider ?? '' };
      });
    });
  }

  async function sourceFor(feedId: string) {
    if (sources.has(feedId)) return sources.get(feedId);
    return options.inTenant(async (tx) => {
      routing ??= await loadRouting(tx);
      const feed = routing.feeds.get(feedId);
      const provider = feed ? options.providers[feed.provider] : undefined;
      let source: HistoricalDataProvider | undefined;
      if (feed && provider) {
        const credential =
          // A custom feed has a key only when its description signs in with one (ADR 0041).
          feed.credentialRef && (provider.needsCredential || feed.config)
            ? await openCredential(tx, {
                userId: options.userId,
                id: feed.credentialRef,
                privateKey: options.privateKey,
              })
            : undefined;
        if (!provider.needsCredential || credential) {
          source = provider.history({
            now: options.now,
            credential,
            feed: { id: feed.id, config: feed.config },
            userId: options.userId,
            inTenant: options.inTenant,
          });
        }
      }
      sources.set(feedId, source);
      return source;
    });
  }

  return {
    id: 'routed',
    intervals: ['5m', '1h', '1d'],
    /**
     * The primary feed answers; when it cannot (it is unreachable, over its
     * limit, or lacks the interval, like a daily-only custom feed asked for
     * 5-minute bars), the route's fallback answers instead and the series
     * says so (ADR 0041).
     */
    async getBars(request) {
      const candidates = await candidatesFor(request.instrumentId, request.symbol);
      let firstError: unknown;
      for (const [i, c] of candidates.entries()) {
        const source = await sourceFor(c.feedId);
        if (!source) continue;
        try {
          const series = await source.getBars(request);
          options.onFeed?.(request.instrumentId, {
            id: c.feedId,
            name: c.name,
            provider: c.provider,
          });
          const first = candidates[0];
          if (i > 0 && first) {
            const why = firstError instanceof Error ? `: ${firstError.message}` : '';
            return {
              ...series,
              warnings: [
                `Bars came from the backup feed ${c.name} because ${first.name} could not give them${why}`.slice(
                  0,
                  300,
                ),
                ...series.warnings,
              ],
            };
          }
          return series;
        } catch (error) {
          firstError ??= error;
          if (i === candidates.length - 1) throw error;
        }
      }
      if (firstError) throw firstError;
      throw new UnsupportedBarRequestError(
        `The data feed for ${request.symbol} cannot give bars right now`,
      );
    },
  };
}
