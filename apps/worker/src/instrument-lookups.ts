import { AlpacaAuthError } from '@tm/alpaca';
import {
  claimInstrumentLookups,
  finishLookup,
  loadPendingLookup,
  loadRouting,
  openCredential,
  registerInstrument,
  withTenant,
  type Database,
  type CredentialKey,
} from '@tm/db';
import {
  BrokerUnavailableError,
  findIndexListing,
  providerCoversVenue,
  resolveRoute,
} from '@tm/domain';
import type { Logger } from 'pino';
import { withTimeout, type ProviderRegistry } from './providers';

/**
 * Answers instrument lookups (ADR 0017): finds the symbol through the
 * tenant's US stock data feed and registers what the provider confirms.
 * A provider that cannot be reached is retried a few times, then reported.
 */

export const LOOKUPS = {
  leaseSeconds: 45,
  batch: 5,
  maxAttempts: 3,
  timeoutMs: 10_000,
  /** The first search downloads the provider's asset list. */
  searchTimeoutMs: 30_000,
} as const;

export interface LookupOptions {
  db: Database;
  providers: ProviderRegistry;
  privateKey: CredentialKey | undefined;
  logger: Pick<Logger, 'info' | 'warn'>;
  now?: () => Date;
}

const NO_FEED =
  'Add a data feed for US stocks, such as Alpaca, in Settings › Data feeds, then try again.';

export async function runInstrumentLookups(options: LookupOptions): Promise<number> {
  const claimed = await claimInstrumentLookups(options.db, {
    leaseSeconds: LOOKUPS.leaseSeconds,
    limit: LOOKUPS.batch,
  });
  for (const { lookupId, userId } of claimed) {
    await withTenant(options.db, { userId }, async (tx) => {
      const lookup = await loadPendingLookup(tx, lookupId);
      if (!lookup) return;
      // An index the app knows, such as the VIX: registered as indicator-only,
      // never a VIX-futures ETF the stock feed would offer (v1.2 item 5).
      const index = findIndexListing(lookup.query ?? lookup.symbol ?? '');
      if (index) {
        const instrumentId = await registerInstrument(tx, {
          assetClass: 'index',
          symbol: index.symbol,
          venue: index.venue,
          displayName: index.displayName,
          provider: index.provider,
          providerId: index.providerId,
        });
        await finishLookup(tx, lookupId, { status: 'found', instrumentId });
        options.logger.info({ lookupId, symbol: index.symbol }, 'index found');
        return;
      }
      const routing = await loadRouting(tx);
      // The feed behind the any-venue US stock route, else any active feed that can look up.
      const route = resolveRoute(routing.routes, {
        assetClass: 'stock',
        venue: 'US',
        dataType: 'quotes',
      });
      const candidates = [route?.primaryFeedId, route?.fallbackFeedId, ...routing.feeds.keys()];
      const feed = candidates
        .map((id) => (id ? routing.feeds.get(id) : undefined))
        .find((f) => {
          const p = f && options.providers[f.provider];
          return f?.isActive && p?.lookup && providerCoversVenue(f.provider, 'US');
        });
      const provider = feed && options.providers[feed.provider];
      if (!feed || !provider?.lookup) {
        await finishLookup(tx, lookupId, { status: 'failed', message: NO_FEED });
        return;
      }
      const now = options.now ?? (() => new Date());
      try {
        const credential =
          provider.needsCredential && feed.credentialRef
            ? await openCredential(tx, {
                userId,
                id: feed.credentialRef,
                privateKey: options.privateKey,
              })
            : undefined;
        const listing = lookup.symbol
          ? await withTimeout(
              provider.lookup({ now, credential }, lookup.symbol),
              LOOKUPS.timeoutMs,
              'The lookup',
            )
          : undefined;
        if (!listing) {
          // Not a ticker: search names and symbols, and let the person pick.
          const text = lookup.query ?? lookup.symbol ?? '';
          const candidates = provider.search
            ? await withTimeout(
                provider.search({ now, credential }, text),
                LOOKUPS.searchTimeoutMs,
                'The search',
              )
            : [];
          await finishLookup(tx, lookupId, {
            status: 'not_found',
            message:
              candidates.length > 0
                ? `Nothing trades as “${text}”. Did you mean one of these?`
                : `No US stock or ETF matches “${text}”.`,
            candidates,
          });
          return;
        }
        const instrumentId = await registerInstrument(tx, { ...listing, provider: feed.provider });
        await finishLookup(tx, lookupId, { status: 'found', instrumentId });
        options.logger.info({ lookupId, symbol: listing.symbol }, 'instrument found');
      } catch (error) {
        const name = (error as Error).name;
        options.logger.warn({ lookupId, err: { name } }, 'instrument lookup failed');
        if (error instanceof AlpacaAuthError) {
          await finishLookup(tx, lookupId, {
            status: 'failed',
            message: `${feed.name} refused its API key. Replace it under Stored API keys.`,
          });
        } else if (
          (error instanceof BrokerUnavailableError || /timed out/.test(String(error))) &&
          lookup.attempts < LOOKUPS.maxAttempts
        ) {
          await finishLookup(tx, lookupId, { status: 'retry' });
        } else {
          await finishLookup(tx, lookupId, {
            status: 'failed',
            message: `${feed.name} could not look up ${lookup.query ?? lookup.symbol}. Try again later.`,
          });
        }
      }
    });
  }
  return claimed.length;
}

export interface LookupLoop {
  stop: () => Promise<void>;
}

export function startInstrumentLookupLoop(
  options: LookupOptions & { pollMs?: number },
): LookupLoop {
  const pollMs = options.pollMs ?? 1000;
  let running = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const done = (async () => {
    while (running) {
      let handled = 0;
      try {
        handled = await runInstrumentLookups(options);
      } catch (error) {
        options.logger.warn({ err: { name: (error as Error).name } }, 'lookup queue unavailable');
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
