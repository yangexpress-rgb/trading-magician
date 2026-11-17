import {
  MAX_WATCH_GROUPS,
  MAX_WATCH_ITEMS,
  normalizeWatchGroupName,
  normalizeWatchSymbol,
  WATCH_LIST_DEFAULTS,
} from '@tm/domain';
import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { watchListGroups, watchListItems, watchListViews, watchQuotes } from './schema';

/**
 * Watch lists (N292, ADR 0101): each person's groups and symbols (row-level
 * security keeps them theirs), and the latest prices the worker keeps for
 * every watched symbol.
 */

type Db = Database | Transaction;

export class WatchListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WatchListError';
  }
}

export interface WatchListItemRow {
  id: string;
  symbol: string;
  instrumentId: string | null;
  displayName: string | null;
}

export interface WatchListGroupRow {
  id: string;
  name: string;
  collapsed: boolean;
  items: WatchListItemRow[];
}

export interface WatchQuoteRow {
  symbol: string;
  last: number;
  prevClose: number | null;
  priceAt: string;
  daily: boolean;
  source: string;
  extLast: number | null;
  extAt: string | null;
  updatedAt: string;
}

/** The person's groups in order, each with its symbols in order. */
export async function listWatchList(tx: Transaction): Promise<WatchListGroupRow[]> {
  const groups = await tx
    .select({
      id: watchListGroups.id,
      name: watchListGroups.name,
      collapsed: watchListGroups.collapsed,
    })
    .from(watchListGroups)
    .orderBy(asc(watchListGroups.position), asc(watchListGroups.createdAt));
  if (groups.length === 0) return [];
  const items = await tx
    .select({
      id: watchListItems.id,
      groupId: watchListItems.groupId,
      symbol: watchListItems.symbol,
      instrumentId: watchListItems.instrumentId,
      displayName: watchListItems.displayName,
    })
    .from(watchListItems)
    .orderBy(asc(watchListItems.position), asc(watchListItems.createdAt));
  return groups.map((g) => ({
    ...g,
    items: items.filter((i) => i.groupId === g.id).map(({ groupId: _groupId, ...i }) => i),
  }));
}

/**
 * The person's list, started with the default groups the first time it is
 * opened. Returns whether it was just started.
 */
export async function ensureWatchList(
  tx: Transaction,
  userId: string,
): Promise<{ groups: WatchListGroupRow[]; started: boolean }> {
  const groups = await listWatchList(tx);
  if (groups.length > 0) return { groups, started: false };
  // Taken once: a list emptied later stays empty.
  const [seen] = await tx
    .select({ userId: watchListViews.userId })
    .from(watchListViews)
    .where(eq(watchListViews.userId, userId));
  if (seen) return { groups, started: false };
  for (const [position, g] of WATCH_LIST_DEFAULTS.entries()) {
    const [row] = await tx
      .insert(watchListGroups)
      .values({ userId, name: g.name, position })
      .returning({ id: watchListGroups.id });
    if (!row) continue;
    await tx.insert(watchListItems).values(
      g.items.map((i, n) => ({
        userId,
        groupId: row.id,
        symbol: i.symbol,
        displayName: i.displayName,
        position: n,
      })),
    );
  }
  await touchWatchView(tx, userId, 0);
  return { groups: await listWatchList(tx), started: true };
}

/** Marks the list as open now, at most once every `minSeconds`; the worker prices open lists. */
export async function touchWatchView(tx: Transaction, userId: string, minSeconds = 5) {
  await tx
    .insert(watchListViews)
    .values({ userId })
    .onConflictDoUpdate({
      target: watchListViews.userId,
      set: { viewedAt: sql`now()` },
      setWhere: sql`${watchListViews.viewedAt} < now() - make_interval(secs => ${minSeconds})`,
    });
}

async function nextPosition(tx: Transaction, groupId?: string): Promise<number> {
  const [row] = groupId
    ? await tx
        .select({ n: sql<number>`coalesce(max(${watchListItems.position}) + 1, 0)::int` })
        .from(watchListItems)
        .where(eq(watchListItems.groupId, groupId))
    : await tx
        .select({ n: sql<number>`coalesce(max(${watchListGroups.position}) + 1, 0)::int` })
        .from(watchListGroups);
  return row?.n ?? 0;
}

export async function addWatchGroup(
  tx: Transaction,
  userId: string,
  rawName: string,
): Promise<string> {
  const name = normalizeWatchGroupName(rawName);
  if (!name) throw new WatchListError('Give the group a name of up to 40 characters.');
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(watchListGroups);
  if ((count?.n ?? 0) >= MAX_WATCH_GROUPS)
    throw new WatchListError(`A watch list holds up to ${MAX_WATCH_GROUPS} groups.`);
  const [row] = await tx
    .insert(watchListGroups)
    .values({ userId, name, position: await nextPosition(tx) })
    .returning({ id: watchListGroups.id });
  if (!row) throw new WatchListError('The group was not added.');
  return row.id;
}

export async function renameWatchGroup(tx: Transaction, groupId: string, rawName: string) {
  const name = normalizeWatchGroupName(rawName);
  if (!name) throw new WatchListError('Give the group a name of up to 40 characters.');
  await tx
    .update(watchListGroups)
    .set({ name, updatedAt: sql`now()` })
    .where(eq(watchListGroups.id, groupId));
}

export async function setWatchGroupCollapsed(tx: Transaction, groupId: string, collapsed: boolean) {
  await tx
    .update(watchListGroups)
    .set({ collapsed, updatedAt: sql`now()` })
    .where(eq(watchListGroups.id, groupId));
}

/** Moves a group one place up or down. */
export async function moveWatchGroup(tx: Transaction, groupId: string, by: -1 | 1) {
  const groups = await listWatchList(tx);
  const at = groups.findIndex((g) => g.id === groupId);
  const to = at + by;
  if (at < 0 || to < 0 || to >= groups.length) return;
  const order = groups.map((g) => g.id);
  [order[at], order[to]] = [order[to] as string, order[at] as string];
  for (const [position, id] of order.entries())
    await tx.update(watchListGroups).set({ position }).where(eq(watchListGroups.id, id));
}

export async function deleteWatchGroup(tx: Transaction, groupId: string) {
  await tx.delete(watchListGroups).where(eq(watchListGroups.id, groupId));
}

/** Adds a symbol to a group; a symbol already in the group stays where it is. */
export async function addWatchItem(
  tx: Transaction,
  userId: string,
  input: {
    groupId: string;
    symbol: string;
    instrumentId?: string | null | undefined;
    displayName?: string | null | undefined;
  },
): Promise<void> {
  const symbol = normalizeWatchSymbol(input.symbol);
  if (!symbol) throw new WatchListError(`“${input.symbol}” is not a US ticker.`);
  const [group] = await tx
    .select({ id: watchListGroups.id })
    .from(watchListGroups)
    .where(eq(watchListGroups.id, input.groupId));
  if (!group) throw new WatchListError('That group no longer exists.');
  const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(watchListItems);
  if ((count?.n ?? 0) >= MAX_WATCH_ITEMS)
    throw new WatchListError(`A watch list holds up to ${MAX_WATCH_ITEMS} symbols.`);
  await tx
    .insert(watchListItems)
    .values({
      userId,
      groupId: group.id,
      symbol,
      instrumentId: input.instrumentId ?? null,
      displayName: input.displayName?.slice(0, 120) ?? null,
      position: await nextPosition(tx, group.id),
    })
    .onConflictDoUpdate({
      target: [watchListItems.groupId, watchListItems.symbol],
      set: {
        instrumentId: sql`coalesce(excluded.instrument_id, ${watchListItems.instrumentId})`,
        displayName: sql`coalesce(excluded.display_name, ${watchListItems.displayName})`,
      },
    });
}

export async function removeWatchItem(tx: Transaction, itemId: string) {
  await tx.delete(watchListItems).where(eq(watchListItems.id, itemId));
}

/** Moves a symbol one place up or down within its group. */
export async function moveWatchItem(tx: Transaction, itemId: string, by: -1 | 1) {
  const [item] = await tx
    .select({ groupId: watchListItems.groupId })
    .from(watchListItems)
    .where(eq(watchListItems.id, itemId));
  if (!item) return;
  const rows = await tx
    .select({ id: watchListItems.id })
    .from(watchListItems)
    .where(eq(watchListItems.groupId, item.groupId))
    .orderBy(asc(watchListItems.position), asc(watchListItems.createdAt));
  const order = rows.map((r) => r.id);
  const at = order.indexOf(itemId);
  const to = at + by;
  if (at < 0 || to < 0 || to >= order.length) return;
  [order[at], order[to]] = [order[to] as string, order[at] as string];
  for (const [position, id] of order.entries())
    await tx.update(watchListItems).set({ position }).where(eq(watchListItems.id, id));
}

/** The latest stored prices of these symbols. */
export async function loadWatchQuotes(
  db: Db,
  symbols: readonly string[],
): Promise<WatchQuoteRow[]> {
  if (symbols.length === 0) return [];
  const rows = await db
    .select()
    .from(watchQuotes)
    .where(inArray(watchQuotes.symbol, [...new Set(symbols)]));
  return rows.map((r) => ({
    symbol: r.symbol,
    last: r.last,
    prevClose: r.prevClose,
    priceAt: r.priceAt.toISOString(),
    daily: r.daily,
    source: r.source,
    extLast: r.extLast,
    extAt: r.extAt?.toISOString() ?? null,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** Worker: who has a list open, and the symbols on it (through `watch_list_demand`). */
export async function watchListDemand(
  db: Db,
  seconds: number,
): Promise<{ userId: string; symbol: string }[]> {
  const rows = await db.execute<{ watcher: string; symbol: string }>(
    sql`select * from watch_list_demand(${seconds})`,
  );
  return rows.map((r) => ({ userId: r.watcher, symbol: r.symbol }));
}

/** Worker: when each symbol's stored price was last written. */
export async function watchQuoteAges(
  db: Db,
  symbols: readonly string[],
): Promise<Map<string, Date>> {
  const out = new Map<string, Date>();
  if (symbols.length === 0) return out;
  const rows = await db
    .select({ symbol: watchQuotes.symbol, updatedAt: watchQuotes.updatedAt })
    .from(watchQuotes)
    .where(inArray(watchQuotes.symbol, [...new Set(symbols)]));
  for (const r of rows) out.set(r.symbol, r.updatedAt);
  return out;
}

/** Worker: writes the latest prices, replacing what was there. */
export async function saveWatchQuotes(
  db: Db,
  rows: readonly {
    symbol: string;
    last: number;
    prevClose: number | null;
    priceAt: Date;
    daily: boolean;
    source: string;
    extLast?: number | null;
    extAt?: Date | null;
  }[],
): Promise<number> {
  const values = rows
    .filter((r) => Number.isFinite(r.last) && r.last > 0)
    .map((r) => {
      const { extLast, extAt } = r;
      const ok = extLast != null && Number.isFinite(extLast) && extLast > 0 && extAt != null;
      return { ...r, extLast: ok ? extLast : null, extAt: ok ? extAt : null };
    });
  if (values.length === 0) return 0;
  await db
    .insert(watchQuotes)
    .values(values.map((r) => ({ ...r, updatedAt: sql`now()` })))
    .onConflictDoUpdate({
      target: watchQuotes.symbol,
      set: {
        last: sql`excluded.last`,
        prevClose: sql`excluded.prev_close`,
        priceAt: sql`excluded.price_at`,
        daily: sql`excluded.daily`,
        source: sql`excluded.source`,
        extLast: sql`excluded.ext_last`,
        extAt: sql`excluded.ext_at`,
        updatedAt: sql`now()`,
      },
    });
  return values.length;
}
