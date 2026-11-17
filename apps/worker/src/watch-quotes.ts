import {
  feedScope,
  loadRouting,
  openCredential,
  saveWatchQuotes,
  watchListDemand,
  type CredentialKey,
  type Database,
  type RoutingFeed,
  type TenantRunner,
} from '@tm/db';
import {
  indexListingBySymbol,
  providerCoversVenue,
  resolveRoute,
  WATCH_DEMAND_SECONDS,
  watchRefreshMs,
} from '@tm/domain';
import type { Logger } from 'pino';
import {
  withTimeout,
  type MarketDataProvider,
  type ProviderRegistry,
  type WatchPriceResult,
} from './providers';

/**
 * Keeps watch list prices fresh (N292, ADR 0101). Only lists someone has open
 * are priced: every few seconds while US stocks trade, once a minute
 * otherwise. Each person's symbols go through their own price feed, or the
 * admin's shared one (N237); people on the same feed share one request per
 * 100 symbols, so the shared key's request budget (ADR 0052) is barely
 * touched. Index rows such as the VIX come from Cboe's daily history.
 */

const WATCH_TIMEOUT_MS = 15_000;
/** Index rows are daily closes: asked for again at most this often. */
const INDEX_REFRESH_MS = 10 * 60_000;

export interface WatchQuoteOptions {
  db: Database;
  providers: ProviderRegistry;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

/** The feed that prices a person's US stocks: the US stock route's, else any real one that can. */
export function pickWatchFeed(
  routing: Awaited<ReturnType<typeof loadRouting>>,
  providers: ProviderRegistry,
): { feed: RoutingFeed; provider: MarketDataProvider } | undefined {
  const route = resolveRoute(routing.routes, {
    assetClass: 'stock',
    venue: 'US',
    dataType: 'quotes',
  });
  const ids = [route?.primaryFeedId, route?.fallbackFeedId, ...routing.feeds.keys()];
  for (const id of ids) {
    const feed = id ? routing.feeds.get(id) : undefined;
    const provider = feed ? providers[feed.provider] : undefined;
    if (feed?.isActive && provider?.watch && providerCoversVenue(feed.provider, 'US'))
      return { feed, provider };
  }
  return undefined;
}

export interface WatchQuoteState {
  /** When each symbol was last asked for, by this worker. */
  asked: Map<string, number>;
}

export const newWatchQuoteState = (): WatchQuoteState => ({ asked: new Map() });

/** One pass: prices the due symbols of every open list. Returns how many prices were written. */
export async function runWatchQuotes(
  options: WatchQuoteOptions,
  state: WatchQuoteState,
): Promise<number> {
  const now = options.now ?? (() => new Date());
  const demand = await watchListDemand(options.db, WATCH_DEMAND_SECONDS);
  if (demand.length === 0) return 0;
  const at = now();
  const t = at.getTime();
  const every = watchRefreshMs(at);
  const due = (symbol: string, ms: number) => t - (state.asked.get(symbol) ?? 0) >= ms;

  const indices = new Set<string>();
  const byUser = new Map<string, Set<string>>();
  for (const { userId, symbol } of demand) {
    if (indexListingBySymbol(symbol)?.provider === 'cboe') {
      if (due(symbol, INDEX_REFRESH_MS)) indices.add(symbol);
      continue;
    }
    if (!due(symbol, every)) continue;
    const set = byUser.get(userId) ?? new Set<string>();
    set.add(symbol);
    byUser.set(userId, set);
  }

  // People whose prices come from the same feed are asked for together.
  const byScope = new Map<string, { inTenant: TenantRunner; symbols: Set<string> }>();
  for (const [userId, symbols] of byUser) {
    const scope = await feedScope(options.db, userId, 'prices');
    const entry = byScope.get(scope.userId) ?? { inTenant: scope.inTenant, symbols: new Set() };
    for (const s of symbols) entry.symbols.add(s);
    byScope.set(scope.userId, entry);
  }

  const prices: WatchPriceResult[] = [];
  for (const [scopeUser, { inTenant, symbols }] of byScope) {
    const wanted = [...symbols].filter((s) => due(s, every));
    if (wanted.length === 0) continue;
    for (const s of wanted) state.asked.set(s, t);
    try {
      const picked = await inTenant(async (tx) => {
        const found = pickWatchFeed(await loadRouting(tx), options.providers);
        if (!found) return undefined;
        const key = found.provider.needsCredential ? found.feed.credentialRef : null;
        const credential = key
          ? await openCredential(tx, { userId: scopeUser, id: key, privateKey: options.privateKey })
          : undefined;
        return { ...found, credential };
      });
      if (!picked?.provider.watch) continue;
      const got = await withTimeout(
        picked.provider.watch(
          { now, credential: picked.credential, userId: scopeUser, inTenant },
          wanted,
        ),
        WATCH_TIMEOUT_MS,
        'watch list prices',
      );
      prices.push(...got);
    } catch (error) {
      options.logger.warn(
        { err: { name: (error as Error).name, message: (error as Error).message } },
        'watch list prices unavailable for a feed',
      );
    }
  }

  const cboe = options.providers.cboe;
  if (indices.size > 0 && cboe?.watch) {
    for (const s of indices) state.asked.set(s, t);
    try {
      prices.push(...(await cboe.watch({ now }, [...indices])));
    } catch (error) {
      options.logger.warn(
        { err: { name: (error as Error).name } },
        'watch list index closes unavailable',
      );
    }
  }
  return saveWatchQuotes(options.db, prices);
}

export interface WatchQuoteLoop {
  stop(): Promise<void>;
}

export function startWatchQuoteLoop(
  options: WatchQuoteOptions & { pollMs?: number },
): WatchQuoteLoop {
  const pollMs = options.pollMs ?? 1000;
  const state = newWatchQuoteState();
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const done = (async () => {
    while (running) {
      try {
        await runWatchQuotes(options, state);
      } catch (error) {
        options.logger.warn(
          { err: { name: (error as Error).name } },
          'watch list prices unavailable',
        );
      }
      if (!running) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, pollMs);
      });
    }
  })();
  return {
    stop: async () => {
      running = false;
      clearTimeout(timer);
      wake?.();
      await done;
    },
  };
}
