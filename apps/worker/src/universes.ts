import {
  feedScope,
  instrumentsBySymbol,
  loadRouting,
  membershipPeriodsBetween,
  openCredential,
  registerInstrument,
  spansByInstrument,
  withTenant,
  type CredentialKey,
  type Database,
  type TenantRunner,
} from '@tm/db';
import {
  isPointInTimeGroup,
  SP500_PERIODS_THROUGH,
  providerCoversVenue,
  resolveRoute,
  stockGroup,
  stockGroupSymbols,
  type BuiltinUniverse,
  type MembershipSpan,
} from '@tm/domain';
import type { ProviderRegistry } from './providers';

interface ResolveOptions {
  db: Database;
  userId: string;
  providers: ProviderRegistry;
  privateKey: CredentialKey | undefined;
  now: () => Date;
}

/**
 * Instruments for US stock symbols: those already registered, and the rest
 * confirmed with the tenant's US stock feed in one listing call and
 * registered, as a lookup would. Symbols the feed doesn't list are missing
 * from the result.
 */
export async function resolveStockSymbols(
  options: ResolveOptions,
  symbols: readonly string[],
): Promise<Map<string, string>> {
  const { db, userId } = options;
  const inTenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, { userId }, fn);
  const known = await inTenant((tx) => instrumentsBySymbol(tx, [...symbols]));
  const missing = symbols.filter((s) => !known.has(s));
  if (missing.length === 0) return known;
  // Without a price feed of their own, the admin's shared one finds them (N237, ADR 0084).
  const feeds = await feedScope(db, userId, 'prices');
  await inTenant(async (tx) => {
    const inFeeds: TenantRunner = feeds.shared ? feeds.inTenant : (fn) => fn(tx);
    const routing = await inFeeds(loadRouting);
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
        ? await inFeeds((t) =>
            openCredential(t, {
              userId: feeds.userId,
              id: feed.credentialRef as string,
              privateKey: options.privateKey,
            }),
          )
        : undefined;
    const found = await provider.listings({ now: options.now, credential }, missing);
    for (const listing of found) {
      known.set(
        listing.symbol,
        await registerInstrument(tx, { ...listing, provider: feed.provider }),
      );
    }
  });
  return known;
}

export interface ResolvedUniverse {
  ids: string[];
  warnings: string[];
  /**
   * Point-in-time membership (N324, ADR 0112): each member's spans in the
   * group, when the group has a history and a date range was asked for. The
   * back test reads members as of each day from these.
   */
  spans?: Map<string, MembershipSpan[]>;
  /** The group's member count and how current its data is, for the result's face (O208). */
  coverage: { label: string; asOf: string; pointInTime: boolean; members: number };
}

/**
 * Resolves a built-in stock group (ADR 0080) to instruments for a back test
 * (Design v1.2 item 1). With a date range and a group that has a stored
 * history (the S&P 500, N324), the members are everyone who was one at some
 * point in the range, with their spans, so the back test reads members as of
 * each day; members that were delisted since and that no feed lists are left
 * out and counted. Otherwise each group is today's member list that ships
 * with the app (the screener's), so a back test over past years carries
 * survivorship bias; the result says so.
 */
export async function resolveBuiltinUniverse(
  options: ResolveOptions & {
    /** Which group; the S&P 500 when absent. */
    group?: BuiltinUniverse;
    /** The back test's days; paper and live runs leave it out and read today's list. */
    range?: { from: string; to: string };
  },
): Promise<ResolvedUniverse> {
  const group = options.group ?? 'sp500';
  const label = stockGroup(group).label;
  if (options.range && isPointInTimeGroup(group)) {
    const periods = await membershipPeriodsBetween(
      options.db,
      group,
      options.range.from,
      options.range.to,
    );
    if (periods.length > 0) {
      const spans = spansByInstrument(periods);
      const unresolved = [...new Set(periods.filter((p) => !p.instrumentId).map((p) => p.symbol))];
      const symbols = new Set(periods.map((p) => p.symbol));
      const warnings = [
        `The ${label} universe follows its members on each day (point in time): ${symbols.size} companies were members at some point in this range`,
      ];
      if (unresolved.length > 0)
        warnings.push(
          `${unresolved.length} of them have no price history in the app (most were delisted after leaving) and were left out: ${unresolved.slice(0, 10).join(', ')}${unresolved.length > 10 ? '…' : ''}`,
        );
      return {
        ids: [...spans.keys()].sort(),
        warnings,
        spans,
        coverage: { label, asOf: SP500_PERIODS_THROUGH, pointInTime: true, members: symbols.size },
      };
    }
  }
  const symbols = stockGroupSymbols(group);
  const known = await resolveStockSymbols(options, symbols);
  const warnings = [
    `The ${label} universe is today’s member list, so earlier years leave out companies that have since left it (survivorship bias)`,
  ];
  const left = symbols.filter((s) => !known.has(s));
  if (left.length > 0) {
    warnings.push(
      `${left.length} ${label} members could not be found with your data feed and were left out: ${left.slice(0, 10).join(', ')}${left.length > 10 ? '…' : ''}`,
    );
  }
  return {
    ids: symbols.flatMap((s) => known.get(s) ?? []),
    warnings,
    coverage: {
      label,
      asOf: stockGroup(group).asOf,
      pointInTime: false,
      members: symbols.length,
    },
  };
}
