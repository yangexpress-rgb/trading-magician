import { isFundamentalsProvider, isMarketDataProvider, isOptionsProvider } from '@tm/domain';
import { eq, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { dataFeedConnections } from './schema';
import { withTenant } from './tenant';

/**
 * Shared data feeds (N237, ADR 0084). A member with no active feed of a kind
 * uses the active feeds of that kind belonging to the oldest platform admin
 * who shares (on by default; the admin turns it off in Settings › Data feeds).
 * The kinds are separate: a member who adds only SEC EDGAR still gets the
 * admin's prices. Members see the shared feeds' names and providers, never
 * their keys or settings; the worker opens the keys in the admin's own tenant,
 * so the admin's request budgets, caches and failover apply.
 */
export type SharedFeedKind = 'prices' | 'company' | 'options';

export function sharedFeedKindOf(provider: string): SharedFeedKind | undefined {
  if (isFundamentalsProvider(provider)) return 'company';
  if (isOptionsProvider(provider)) return 'options';
  if (isMarketDataProvider(provider)) return 'prices';
  return undefined;
}

export interface SharedFeed {
  id: string;
  name: string;
  provider: string;
  kind: SharedFeedKind;
}

/** The sharing admin's active feeds, oldest first; empty when nobody shares. */
export async function sharedFeeds(tx: Database | Transaction): Promise<SharedFeed[]> {
  const rows = await tx.execute<{ id: string; name: string; provider: string }>(
    sql`select id, name, provider from shared_data_feeds()`,
  );
  return [...rows].flatMap((r) => {
    const kind = sharedFeedKindOf(r.provider);
    return kind ? [{ id: r.id, name: r.name, provider: r.provider, kind }] : [];
  });
}

/** What the sharing admin's price routes cover, as `assetClass:dataType` keys. */
export async function sharedRouteKeys(tx: Transaction): Promise<Set<string>> {
  const rows = await tx.execute<{ asset_class: string; data_type: string }>(
    sql`select asset_class, data_type from shared_data_routes()`,
  );
  return new Set([...rows].map((r) => `${r.asset_class}:${r.data_type}`));
}

/** The admin whose feeds are shared, or null when nobody shares. */
export async function sharedFeedOwner(tx: Transaction): Promise<string | null> {
  const [row] = await tx.execute<{ owner: string | null }>(
    sql`select shared_feed_owner() as owner`,
  );
  return row?.owner ?? null;
}

/** Whether the tenant has an active feed of its own of this kind. */
export async function hasOwnFeed(
  tx: Database | Transaction,
  kind: SharedFeedKind,
): Promise<boolean> {
  const rows = await tx
    .select({ provider: dataFeedConnections.provider })
    .from(dataFeedConnections)
    .where(eq(dataFeedConnections.isActive, true));
  return rows.some((r) => sharedFeedKindOf(r.provider) === kind);
}

/** The shared feeds of a kind the tenant uses because it has none of its own. */
export async function sharedFeedsInUse(
  tx: Transaction,
  kind: SharedFeedKind,
): Promise<SharedFeed[]> {
  if (await hasOwnFeed(tx, kind)) return [];
  return (await sharedFeeds(tx)).filter((f) => f.kind === kind);
}

export type TenantRunner = <T>(fn: (tx: Transaction) => Promise<T>) => Promise<T>;

/**
 * Whose feeds of a kind answer for this member, for the worker: their own,
 * or the sharing admin's. `userId` and `inTenant` are the feeds' owner's, for
 * reading routes and feeds, opening keys and the providers' own bookkeeping;
 * anything that belongs to the member stays in the member's tenant.
 */
export interface FeedScope {
  userId: string;
  shared: boolean;
  inTenant: TenantRunner;
}

export async function feedScope(
  db: Database,
  userId: string,
  kind: SharedFeedKind,
): Promise<FeedScope> {
  const own: FeedScope = {
    userId,
    shared: false,
    inTenant: (fn) => withTenant(db, { userId }, fn),
  };
  const owner = await withTenant(db, { userId }, async (tx) => {
    if ((await sharedFeedsInUse(tx, kind)).length === 0) return null;
    return sharedFeedOwner(tx);
  });
  if (!owner || owner === userId) return own;
  return { userId: owner, shared: true, inTenant: (fn) => withTenant(db, { userId: owner }, fn) };
}

/** The signed-in admin's choice to share their feeds; refused for anyone else. */
export async function adminFeedSharing(tx: Transaction): Promise<boolean> {
  const [row] = await tx.execute<{ shares: boolean | null }>(
    sql`select admin_feed_sharing() as shares`,
  );
  return row?.shares === true;
}

export async function adminSetFeedSharing(tx: Transaction, on: boolean): Promise<boolean> {
  const [row] = await tx.execute<{ changed: boolean }>(
    sql`select admin_set_feed_sharing(${on}) as changed`,
  );
  return row?.changed === true;
}
