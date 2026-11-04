import { AlpacaAuthError } from '@tm/alpaca';
import {
  claimStockScreens,
  finishStockScreen,
  listTenantInstruments,
  loadPendingScreen,
  loadRouting,
  openCredential,
  withTenant,
  type Database,
  type RoutingFeed,
  type Transaction,
} from '@tm/db';
import {
  BrokerUnavailableError,
  providerCoversVenue,
  resolveRoute,
  screenRow,
  screenSession,
  SP500_SECTORS,
  toScreenTuple,
} from '@tm/domain';
import type { Logger } from 'pino';
import { withTimeout, type MarketDataProvider, type ProviderRegistry } from './providers';

/**
 * Fills in stock screens for Quantitative Research (ADR 0030): every US
 * stock and ETF the tenant's US stock feed covers, one row of key values
 * each. Without a feed that can screen the market, the demo instruments are
 * screened from the demo feed. A feed that cannot be reached is retried a
 * few times, then reported.
 */

const SP500_MEMBERS: ReadonlySet<string> = new Set(SP500_SECTORS.keys());

export const SCREENS = { leaseSeconds: 240, batch: 2, maxAttempts: 3, timeoutMs: 180_000 } as const;

export interface StockScreenOptions {
  db: Database;
  providers: ProviderRegistry;
  privateKey: string | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

/** The feed whose market the screen covers: the US stock route's, else any real one that can. */
export function pickScreenFeed(
  routing: Awaited<ReturnType<typeof loadRouting>>,
  providers: ProviderRegistry,
): { feed: RoutingFeed | undefined; provider: MarketDataProvider | undefined } {
  const route = resolveRoute(routing.routes, {
    assetClass: 'stock',
    venue: 'US',
    dataType: 'quotes',
  });
  const ids = [route?.primaryFeedId, route?.fallbackFeedId, ...routing.feeds.keys()];
  const feeds = ids
    .map((id) => (id ? routing.feeds.get(id) : undefined))
    .filter((f): f is RoutingFeed => !!f?.isActive && !!providers[f.provider]?.screen);
  const feed =
    feeds.find((f) => f.provider !== 'demo' && providerCoversVenue(f.provider, 'US')) ??
    feeds.find((f) => f.provider === 'demo');
  return { feed, provider: feed ? providers[feed.provider] : providers.demo };
}

export async function runStockScreens(options: StockScreenOptions): Promise<number> {
  const claimed = await claimStockScreens(options.db, {
    leaseSeconds: SCREENS.leaseSeconds,
    limit: SCREENS.batch,
  });
  const now = options.now ?? (() => new Date());
  for (const { screenId, userId } of claimed) {
    const inTenant = <T>(fn: (tx: Transaction) => Promise<T>) =>
      withTenant(options.db, { userId }, fn);
    const pending = await inTenant((tx) => loadPendingScreen(tx, screenId));
    if (!pending) continue;
    const { feed, provider, credential, known } = await inTenant(async (tx) => {
      const picked = pickScreenFeed(await loadRouting(tx), options.providers);
      const opened =
        picked.provider?.needsCredential && picked.feed?.credentialRef
          ? await openCredential(tx, {
              userId,
              id: picked.feed.credentialRef,
              privateKey: options.privateKey,
            })
          : undefined;
      // Instruments already registered can be charted straight from the screen.
      const known = new Map<string, string>();
      for (const i of await listTenantInstruments(tx)) {
        if (!known.has(i.symbol)) known.set(i.symbol, i.id);
      }
      return { ...picked, credential: opened, known };
    });
    const source = feed?.name ?? 'Demo data';
    try {
      if (!provider?.screen) throw new Error('No feed can screen');
      const result = await withTimeout(
        provider.screen(
          { now, credential },
          pending.universe === 'sp500' ? { symbols: SP500_MEMBERS } : {},
        ),
        SCREENS.timeoutMs,
        'The screen',
      );
      const session = screenSession(result.sources);
      const rows = session
        ? result.sources.map((s) =>
            toScreenTuple(screenRow({ ...s, instrumentId: known.get(s.symbol) ?? null }, session)),
          )
        : [];
      await inTenant((tx) =>
        finishStockScreen(tx, screenId, {
          status: 'ready',
          rows,
          sessionDate: session,
          warnings: result.warnings,
          source,
        }),
      );
      options.logger.info({ screenId, rows: rows.length }, 'stock screen ready');
    } catch (error) {
      const name = (error as Error).name;
      // Provider errors here carry no secrets; the message says what failed.
      options.logger.warn(
        { screenId, err: { name, message: (error as Error).message?.slice(0, 200) } },
        'stock screen failed',
      );
      let outcome: Parameters<typeof finishStockScreen>[2];
      if (error instanceof AlpacaAuthError) {
        outcome = {
          status: 'failed',
          message: `${source} refused its API key. Replace it under Stored API keys.`,
          source,
        };
      } else if (
        (error instanceof BrokerUnavailableError || /timed out/.test(String(error))) &&
        pending.attempts < SCREENS.maxAttempts
      ) {
        outcome = { status: 'retry' };
      } else {
        outcome = {
          status: 'failed',
          message: `${source} could not give prices for the screen. Try again later.`,
          source,
        };
      }
      await inTenant((tx) => finishStockScreen(tx, screenId, outcome));
    }
  }
  return claimed.length;
}

export interface StockScreenLoop {
  stop: () => Promise<void>;
}

export function startStockScreenLoop(
  options: StockScreenOptions & { pollMs?: number },
): StockScreenLoop {
  const pollMs = options.pollMs ?? 1000;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const done = (async () => {
    while (running) {
      let handled = 0;
      try {
        handled = await runStockScreens(options);
      } catch (error) {
        options.logger.warn(
          { err: { name: (error as Error).name } },
          'stock screen queue unavailable',
        );
      }
      if (handled === 0 && running) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          timer = setTimeout(resolve, pollMs);
        });
      }
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
