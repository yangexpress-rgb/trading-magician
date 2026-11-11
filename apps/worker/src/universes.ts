import {
  instrumentsBySymbol,
  loadRouting,
  openCredential,
  registerInstrument,
  withTenant,
  type CredentialKey,
  type Database,
} from '@tm/db';
import {
  providerCoversVenue,
  resolveRoute,
  stockGroup,
  stockGroupSymbols,
  type BuiltinUniverse,
} from '@tm/domain';
import type { ProviderRegistry } from './providers';

/**
 * Resolves a built-in stock group (ADR 0079) to instruments for a back test
 * (Design v1.2 item 1). Each group is today's member list that ships with
 * the app (the screener's), so a back test over past years carries survivorship bias;
 * the result says so. Members not yet registered are confirmed with the
 * tenant's US stock feed in one listing call and registered, as a lookup
 * would; members the feed doesn't list are left out and named.
 */
export async function resolveBuiltinUniverse(options: {
  db: Database;
  userId: string;
  providers: ProviderRegistry;
  privateKey: CredentialKey | undefined;
  now: () => Date;
  /** Which group; the S&P 500 when absent. */
  group?: BuiltinUniverse;
}): Promise<{ ids: string[]; warnings: string[] }> {
  const { db, userId } = options;
  const label = stockGroup(options.group ?? 'sp500').label;
  const symbols = stockGroupSymbols(options.group ?? 'sp500');
  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, { userId }, fn);
  const known = await inTenant((tx) => instrumentsBySymbol(tx, symbols));
  const missing = symbols.filter((s) => !known.has(s));
  const warnings = [
    `The ${label} universe is today’s member list, so earlier years leave out companies that have since left it (survivorship bias)`,
  ];
  if (missing.length > 0) {
    await inTenant(async (tx) => {
      const routing = await loadRouting(tx);
      const route = resolveRoute(routing.routes, {
        assetClass: 'stock',
        venue: 'US',
        dataType: 'quotes',
      });
      const feed = [route?.primaryFeedId, route?.fallbackFeedId, ...routing.feeds.keys()]
        .map((id) => (id ? routing.feeds.get(id) : undefined))
        .find((f) => {
          const p = f && options.providers[f.provider];
          return f?.isActive && p?.listings && providerCoversVenue(f.provider, 'US');
        });
      const provider = feed && options.providers[feed.provider];
      if (!feed || !provider?.listings) return;
      const credential =
        provider.needsCredential && feed.credentialRef
          ? await openCredential(tx, {
              userId,
              id: feed.credentialRef,
              privateKey: options.privateKey,
            })
          : undefined;
      const found = await provider.listings({ now: options.now, credential }, missing);
      for (const listing of found) {
        known.set(
          listing.symbol,
          await registerInstrument(tx, { ...listing, provider: feed.provider }),
        );
      }
    });
  }
  const left = symbols.filter((s) => !known.has(s));
  if (left.length > 0) {
    warnings.push(
      `${left.length} ${label} members could not be found with your data feed and were left out: ${left.slice(0, 10).join(', ')}${left.length > 10 ? '…' : ''}`,
    );
  }
  return { ids: symbols.flatMap((s) => known.get(s) ?? []), warnings };
}
