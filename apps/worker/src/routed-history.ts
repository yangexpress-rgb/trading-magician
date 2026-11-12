import {
  feedScope,
  instrumentRoutingInfo,
  loadRouting,
  openCredential,
  type Routing,
  type Transaction,
  type CredentialKey,
  type Database,
} from '@tm/db';
import {
  resolveRoute,
  UnsupportedBarRequestError,
  type BarRequest,
  type BarSeries,
  type HistoricalDataProvider,
} from '@tm/domain';
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
  /** Wait out feeds' rate limits (back tests over many instruments). */
  patient?: boolean;
  /** Pace requests as background work within each key's budget (5-minute back tests, ADR 0063). */
  background?: boolean;
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
            patient: options.patient ?? false,
            background: options.background ?? false,
          });
        }
      }
      sources.set(feedId, source);
      return source;
    });
  }

  const routed: HistoricalDataProvider = {
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
    /**
     * Requests whose primary feed takes many symbols at once go to it together
     * (ADR 0087); anything that fails there, or whose feed can't batch, takes
     * the one-at-a-time path above, with its fallback.
     */
    async getBarsMany(requests) {
      const out: (BarSeries | Error)[] = new Array(requests.length);
      const byFeed = new Map<string, number[]>();
      const single: number[] = [];
      for (const [i, request] of requests.entries()) {
        let first: Candidate | undefined;
        try {
          first = (await candidatesFor(request.instrumentId, request.symbol))[0];
        } catch (error) {
          out[i] = error instanceof Error ? error : new Error(String(error));
          continue;
        }
        if (first) byFeed.set(first.feedId, [...(byFeed.get(first.feedId) ?? []), i]);
        else single.push(i);
      }
      for (const [feedId, indexes] of byFeed) {
        const source = await sourceFor(feedId);
        if (!source?.getBarsMany || indexes.length < 2) {
          single.push(...indexes);
          continue;
        }
        const results = await source.getBarsMany(indexes.map((i) => requests[i] as BarRequest));
        const feed = routing?.feeds.get(feedId);
        for (const [n, i] of indexes.entries()) {
          const r = results[n];
          if (r && !(r instanceof Error)) {
            out[i] = r;
            if (feed) {
              const request = requests[i] as BarRequest;
              options.onFeed?.(request.instrumentId, {
                id: feedId,
                name: feed.name,
                provider: feed.provider,
              });
            }
          } else single.push(i);
        }
      }
      for (const i of single) {
        try {
          out[i] = await routed.getBars(requests[i] as BarRequest);
        } catch (error) {
          out[i] = error instanceof Error ? error : new Error(String(error));
        }
      }
      return out;
    },
  };
  return routed;
}

/**
 * Bars for a member through whichever routes serve them: their own, or the
 * sharing admin's when they have no price feed (N237, ADR 0084). Which one is
 * decided at the first request.
 */
export function createMemberHistory(
  options: Omit<Parameters<typeof createRoutedHistory>[0], 'inTenant' | 'userId'> & {
    db: Database;
    userId: string;
  },
): HistoricalDataProvider {
  const { db, userId, ...rest } = options;
  let inner: Promise<HistoricalDataProvider> | undefined;
  const resolve = () =>
    (inner ??= feedScope(db, userId, 'prices').then((feeds) =>
      createRoutedHistory({ ...rest, inTenant: feeds.inTenant, userId: feeds.userId }),
    ));
  return {
    id: 'routed',
    intervals: ['5m', '1h', '1d'],
    async getBars(request) {
      return (await resolve()).getBars(request);
    },
    async getBarsMany(requests) {
      const inner = await resolve();
      if (inner.getBarsMany) return inner.getBarsMany(requests);
      const out: (BarSeries | Error)[] = [];
      for (const r of requests)
        out.push(
          await inner
            .getBars(r)
            .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
        );
      return out;
    },
  };
}
