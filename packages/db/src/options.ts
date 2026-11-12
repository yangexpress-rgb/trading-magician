import {
  isOptionsProvider,
  OPTION_SIGNAL_FIELDS,
  type ExpiryValues,
  type OptionRight,
  type OptionSignal,
  type OptionSignalSource,
  type OptionSignalValues,
} from '@tm/domain';
import { and, asc, eq, gte, inArray, lt, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { sharedFeeds } from './feed-sharing';
import { withTenant } from './tenant';
import {
  dataFeedConnections,
  instruments,
  optionChainSnapshots,
  optionContracts,
  optionDailySignals,
  optionExpirySignals,
  optionUniverse,
} from './schema';

/**
 * Options data storage (options data brief v2 §2–§3, ADR 0047). Global
 * public data kept once for every tenant: the worker (tm_secrets) writes it,
 * the app login reads the universe and the derived signals only.
 */

type Db = Database | Transaction;

const CHUNK = 1000;
const toNum = (v: string | null): number | null => (v === null ? null : Number(v));
const toStr = (v: number | null | undefined): string | null =>
  v === null || v === undefined || !Number.isFinite(v) ? null : String(v);

// ---------------------------------------------------------------------------
// Universe

export interface UniverseRow {
  underlyingId: string;
  symbol: string;
  assetClass: string;
  active: boolean;
  addedBy: 'seed' | 'strategy';
  addedAt: Date;
  lastSnapshotDate: string | null;
  lastSignalDate: string | null;
  lastAttemptAt: Date | null;
  attemptDate: string | null;
  attemptCount: number;
  lastError: string | null;
  lastSkipped: number | null;
  rebuildStatus: string;
  rebuildNote: string | null;
}

export async function listOptionUniverse(db: Db, activeOnly = true): Promise<UniverseRow[]> {
  const rows = await db
    .select({
      underlyingId: optionUniverse.underlyingId,
      symbol: instruments.symbol,
      assetClass: instruments.assetClass,
      active: optionUniverse.active,
      addedBy: optionUniverse.addedBy,
      addedAt: optionUniverse.addedAt,
      lastSnapshotDate: optionUniverse.lastSnapshotDate,
      lastSignalDate: optionUniverse.lastSignalDate,
      lastAttemptAt: optionUniverse.lastAttemptAt,
      attemptDate: optionUniverse.attemptDate,
      attemptCount: optionUniverse.attemptCount,
      lastError: optionUniverse.lastError,
      lastSkipped: optionUniverse.lastSkipped,
      rebuildStatus: optionUniverse.rebuildStatus,
      rebuildNote: optionUniverse.rebuildNote,
    })
    .from(optionUniverse)
    .innerJoin(instruments, eq(instruments.id, optionUniverse.underlyingId))
    .where(activeOnly ? eq(optionUniverse.active, true) : sql`true`)
    .orderBy(asc(instruments.symbol));
  return rows.map((r) => ({ ...r, addedBy: r.addedBy as UniverseRow['addedBy'] }));
}

/**
 * The auto-add rule (brief §2): US stocks and ETFs added to a strategy join
 * the universe. Runs as the app login through a definer function; returns how
 * many joined.
 */
export async function addOptionUnderlyings(tx: Db, instrumentIds: readonly string[]) {
  const ids = [...new Set(instrumentIds)];
  if (ids.length === 0) return 0;
  const rows = await tx.execute<{ added: number }>(
    sql`select add_option_underlyings(${sql.raw(`ARRAY[${ids.map((i) => `'${uuidOnly(i)}'`).join(',')}]::uuid[]`)}) as added`,
  );
  return Number(rows[0]?.added ?? 0);
}

function uuidOnly(id: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new Error('Not an instrument id');
  return id;
}

/** Adds the seed list's instruments (worker only); existing rows are left as they are. */
export async function addSeedUnderlyings(db: Db, instrumentIds: readonly string[]) {
  if (instrumentIds.length === 0) return;
  await db
    .insert(optionUniverse)
    .values(instrumentIds.map((underlyingId) => ({ underlyingId, addedBy: 'seed' })))
    .onConflictDoNothing();
}

export type UniversePatch = Partial<
  Pick<
    typeof optionUniverse.$inferInsert,
    | 'lastSnapshotDate'
    | 'lastSignalDate'
    | 'lastAttemptAt'
    | 'attemptDate'
    | 'attemptCount'
    | 'lastError'
    | 'lastSkipped'
    | 'rebuildStatus'
    | 'rebuildNote'
    | 'rebuiltAt'
    | 'active'
  >
>;

export async function updateUniverse(db: Db, underlyingId: string, patch: UniversePatch) {
  await db.update(optionUniverse).set(patch).where(eq(optionUniverse.underlyingId, underlyingId));
}

/** Which of these instruments are in the active universe. */
export async function universeMembers(db: Db, instrumentIds: readonly string[]) {
  if (instrumentIds.length === 0) return new Set<string>();
  const rows = await db
    .select({ id: optionUniverse.underlyingId })
    .from(optionUniverse)
    .where(
      and(
        inArray(optionUniverse.underlyingId, [...instrumentIds]),
        eq(optionUniverse.active, true),
      ),
    );
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Snapshots

export interface SnapshotRowInput {
  occSymbol: string | null;
  expiry: string;
  strike: number;
  right: OptionRight;
  bid: number | null;
  ask: number | null;
  last: number | null;
  volume: number | null;
  openInterest: number | null;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  vega: number | null;
  theta: number | null;
  rho: number | null;
  theo: number | null;
  ivCalc: number | null;
  deltaCalc: number | null;
  gammaCalc: number | null;
}

export interface SnapshotInput {
  underlyingId: string;
  asOfDate: string;
  underlyingClose: number | null;
  rows: readonly SnapshotRowInput[];
  source: 'cboe';
  feed: 'cboe' | 'opra';
  fileTimestamp: Date;
  fetchedAt: Date;
  dataVersion: string;
}

/**
 * Stores one underlying's chain for one day (brief §5.1): upserts the
 * contracts, then replaces that day's snapshot rows, so ingesting a day
 * again never duplicates it.
 */
export async function saveOptionSnapshot(db: Database, input: SnapshotInput): Promise<number> {
  return db.transaction(async (tx) => {
    const ids = new Map<string, string>();
    const key = (e: string, k: number | string, r: string) => `${e}|${Number(k)}|${r}`;
    for (let i = 0; i < input.rows.length; i += CHUNK) {
      const chunk = input.rows.slice(i, i + CHUNK);
      const seen = new Map<string, SnapshotRowInput>();
      for (const r of chunk) seen.set(key(r.expiry, r.strike, r.right), r);
      const saved = await tx
        .insert(optionContracts)
        .values(
          [...seen.values()].map((r) => ({
            underlyingId: input.underlyingId,
            expiry: r.expiry,
            strike: String(r.strike),
            right: r.right,
            occSymbol: r.occSymbol,
            firstSeenAt: input.fetchedAt,
            lastSeenAt: input.fetchedAt,
          })),
        )
        .onConflictDoUpdate({
          target: [
            optionContracts.underlyingId,
            optionContracts.expiry,
            optionContracts.strike,
            optionContracts.right,
          ],
          set: {
            lastSeenAt: input.fetchedAt,
            occSymbol: sql`coalesce(${optionContracts.occSymbol}, excluded.occ_symbol)`,
          },
        })
        .returning({
          id: optionContracts.id,
          expiry: optionContracts.expiry,
          strike: optionContracts.strike,
          right: optionContracts.right,
        });
      for (const c of saved) ids.set(key(c.expiry, c.strike, c.right), c.id);
    }
    await tx
      .delete(optionChainSnapshots)
      .where(
        and(
          eq(optionChainSnapshots.underlyingId, input.underlyingId),
          eq(optionChainSnapshots.asOfDate, input.asOfDate),
        ),
      );
    const unique = new Map<string, SnapshotRowInput>();
    for (const r of input.rows) unique.set(key(r.expiry, r.strike, r.right), r);
    const rows = [...unique.entries()];
    for (let i = 0; i < rows.length; i += CHUNK) {
      await tx.insert(optionChainSnapshots).values(
        rows.slice(i, i + CHUNK).map(([k, r]) => ({
          contractId: ids.get(k) as string,
          underlyingId: input.underlyingId,
          asOfDate: input.asOfDate,
          underlyingClose: toStr(input.underlyingClose),
          bid: toStr(r.bid),
          ask: toStr(r.ask),
          last: toStr(r.last),
          volume: r.volume,
          openInterest: r.openInterest,
          iv: toStr(r.iv),
          delta: toStr(r.delta),
          gamma: toStr(r.gamma),
          vega: toStr(r.vega),
          theta: toStr(r.theta),
          rho: toStr(r.rho),
          theo: toStr(r.theo),
          ivCalc: toStr(r.ivCalc),
          deltaCalc: toStr(r.deltaCalc),
          gammaCalc: toStr(r.gammaCalc),
          source: input.source,
          feed: input.feed,
          fileTimestamp: input.fileTimestamp,
          fetchedAt: input.fetchedAt,
          dataVersion: input.dataVersion,
        })),
      );
    }
    return rows.length;
  });
}

export interface StoredSnapshotRow extends SnapshotRowInput {
  contractId: string;
}

export interface StoredSnapshot {
  underlyingClose: number | null;
  feed: 'cboe' | 'opra';
  rows: StoredSnapshotRow[];
}

/** A stored day's chain for one underlying, or undefined when none was stored. */
export async function loadOptionSnapshot(
  db: Db,
  underlyingId: string,
  asOfDate: string,
): Promise<StoredSnapshot | undefined> {
  const rows = await db
    .select({
      contractId: optionChainSnapshots.contractId,
      occSymbol: optionContracts.occSymbol,
      expiry: optionContracts.expiry,
      strike: optionContracts.strike,
      right: optionContracts.right,
      underlyingClose: optionChainSnapshots.underlyingClose,
      feed: optionChainSnapshots.feed,
      bid: optionChainSnapshots.bid,
      ask: optionChainSnapshots.ask,
      last: optionChainSnapshots.last,
      volume: optionChainSnapshots.volume,
      openInterest: optionChainSnapshots.openInterest,
      iv: optionChainSnapshots.iv,
      delta: optionChainSnapshots.delta,
      gamma: optionChainSnapshots.gamma,
      vega: optionChainSnapshots.vega,
      theta: optionChainSnapshots.theta,
      rho: optionChainSnapshots.rho,
      theo: optionChainSnapshots.theo,
      ivCalc: optionChainSnapshots.ivCalc,
      deltaCalc: optionChainSnapshots.deltaCalc,
      gammaCalc: optionChainSnapshots.gammaCalc,
    })
    .from(optionChainSnapshots)
    .innerJoin(optionContracts, eq(optionContracts.id, optionChainSnapshots.contractId))
    .where(
      and(
        eq(optionChainSnapshots.underlyingId, underlyingId),
        eq(optionChainSnapshots.asOfDate, asOfDate),
      ),
    );
  const first = rows[0];
  if (!first) return undefined;
  return {
    underlyingClose: toNum(first.underlyingClose),
    feed: first.feed as 'cboe' | 'opra',
    rows: rows.map((r) => ({
      contractId: r.contractId,
      occSymbol: r.occSymbol,
      expiry: r.expiry,
      strike: Number(r.strike),
      right: r.right,
      bid: toNum(r.bid),
      ask: toNum(r.ask),
      last: toNum(r.last),
      volume: r.volume,
      openInterest: r.openInterest,
      iv: toNum(r.iv),
      delta: toNum(r.delta),
      gamma: toNum(r.gamma),
      vega: toNum(r.vega),
      theta: toNum(r.theta),
      rho: toNum(r.rho),
      theo: toNum(r.theo),
      ivCalc: toNum(r.ivCalc),
      deltaCalc: toNum(r.deltaCalc),
      gammaCalc: toNum(r.gammaCalc),
    })),
  };
}

/** Sets a stored day's underlying close and computed greeks once the close is known. */
export async function updateSnapshotCalc(
  db: Database,
  underlyingId: string,
  asOfDate: string,
  underlyingClose: number,
  calc: ReadonlyMap<string, { iv: number | null; delta: number | null; gamma: number | null }>,
) {
  await db.transaction(async (tx) => {
    await tx
      .update(optionChainSnapshots)
      .set({ underlyingClose: String(underlyingClose) })
      .where(
        and(
          eq(optionChainSnapshots.underlyingId, underlyingId),
          eq(optionChainSnapshots.asOfDate, asOfDate),
        ),
      );
    const entries = [...calc.entries()];
    for (let i = 0; i < entries.length; i += CHUNK) {
      const chunk = entries.slice(i, i + CHUNK);
      const values = sql.join(
        chunk.map(
          ([id, c]) =>
            sql`(${id}::uuid, ${toStr(c.iv)}::numeric, ${toStr(c.delta)}::numeric, ${toStr(c.gamma)}::numeric)`,
        ),
        sql`, `,
      );
      await tx.execute(sql`
        update option_chain_snapshot as s
           set iv_calc = v.iv, delta_calc = v.delta, gamma_calc = v.gamma
          from (values ${values}) as v(contract_id, iv, delta, gamma)
         where s.contract_id = v.contract_id and s.as_of_date = ${asOfDate}::date`);
    }
  });
}

/** Days with a stored snapshot but no signal yet (the close was not in), oldest first. */
export async function snapshotsAwaitingSignal(db: Db, sinceDate: string) {
  const rows = await db.execute<{ underlying_id: string; as_of_date: string }>(sql`
    select distinct s.underlying_id, s.as_of_date::text as as_of_date
      from option_chain_snapshot s
     where s.as_of_date >= ${sinceDate}::date
       and not exists (select 1 from option_daily_signal d
                        where d.underlying_id = s.underlying_id and d.as_of_date = s.as_of_date)
     order by 2`);
  return [...rows].map((r) => ({ underlyingId: r.underlying_id, asOfDate: r.as_of_date }));
}

// ---------------------------------------------------------------------------
// Signals

const COLUMN: Record<
  (typeof OPTION_SIGNAL_FIELDS)[number],
  keyof typeof optionDailySignals.$inferSelect
> = {
  iv30: 'iv30',
  atm_iv: 'atmIv',
  expected_move_1d_pct: 'expectedMove1dPct',
  expected_move_1d_usd: 'expectedMove1dUsd',
  expected_move_5d_pct: 'expectedMove5dPct',
  expected_move_5d_usd: 'expectedMove5dUsd',
  straddle_move_pct: 'straddleMovePct',
  iv_rank_252d: 'ivRank252d',
  iv_percentile_252d: 'ivPercentile252d',
  iv_rv_ratio: 'ivRvRatio',
  skew_30d: 'skew30d',
  term_structure: 'termStructure',
  put_call_volume: 'putCallVolume',
  put_call_oi: 'putCallOi',
  net_gex: 'netGex',
  call_gex: 'callGex',
  put_gex: 'putGex',
  call_wall: 'callWall',
  put_wall: 'putWall',
  max_pain: 'maxPain',
};

/** A stored signal row's values by field name. */
export function signalRowValues(row: typeof optionDailySignals.$inferSelect): OptionSignalValues {
  return Object.fromEntries(
    OPTION_SIGNAL_FIELDS.map((f) => [f, toNum(row[COLUMN[f]] as string | null)]),
  ) as OptionSignalValues;
}

export interface SignalInput {
  underlyingId: string;
  asOfDate: string;
  values: OptionSignalValues;
  ivHistoryDays: number;
  expiries: readonly ExpiryValues[];
  underlyingClose: number;
  riskFreeRate: number;
  dividendYield: number;
  source: OptionSignalSource;
  feed: 'cboe' | 'opra' | 'alpaca_bars';
  computedAt: Date;
}

/** Stores (or replaces) one underlying's signal row and per-expiry rows for a day. */
export async function saveOptionSignal(db: Database, input: SignalInput): Promise<void> {
  const columns = Object.fromEntries(
    OPTION_SIGNAL_FIELDS.map((f) => [COLUMN[f], toStr(input.values[f])]),
  );
  const row = {
    underlyingId: input.underlyingId,
    asOfDate: input.asOfDate,
    ...columns,
    ivHistoryDays: input.ivHistoryDays,
    underlyingClose: toStr(input.underlyingClose),
    riskFreeRate: toStr(input.riskFreeRate),
    dividendYield: toStr(input.dividendYield),
    source: input.source,
    feed: input.feed,
    computedAt: input.computedAt,
  } as typeof optionDailySignals.$inferInsert;
  const update: Partial<typeof row> = { ...row };
  delete update.underlyingId;
  delete update.asOfDate;
  await db.transaction(async (tx) => {
    await tx
      .insert(optionDailySignals)
      .values(row)
      .onConflictDoUpdate({
        target: [optionDailySignals.underlyingId, optionDailySignals.asOfDate],
        set: update,
      });
    await tx
      .delete(optionExpirySignals)
      .where(
        and(
          eq(optionExpirySignals.underlyingId, input.underlyingId),
          eq(optionExpirySignals.asOfDate, input.asOfDate),
        ),
      );
    if (input.expiries.length > 0)
      await tx.insert(optionExpirySignals).values(
        input.expiries.map((e) => ({
          underlyingId: input.underlyingId,
          asOfDate: input.asOfDate,
          expiry: e.expiry,
          daysToExpiry: e.daysToExpiry,
          atmIv: toStr(e.atmIv),
          putIv25d: toStr(e.putIv25d),
          callIv25d: toStr(e.callIv25d),
          putVolume: e.putVolume === null ? null : Math.round(e.putVolume),
          callVolume: e.callVolume === null ? null : Math.round(e.callVolume),
          putOi: e.putOi === null ? null : Math.round(e.putOi),
          callOi: e.callOi === null ? null : Math.round(e.callOi),
          source: input.source,
          computedAt: input.computedAt,
        })),
      );
  });
}

/** IV30 values of the days before `beforeDate`, back to `sinceDate`, newest first. */
export async function priorIv30(
  db: Db,
  underlyingId: string,
  beforeDate: string,
  sinceDate: string,
  limit: number,
): Promise<number[]> {
  const rows = await db
    .select({ iv30: optionDailySignals.iv30 })
    .from(optionDailySignals)
    .where(
      and(
        eq(optionDailySignals.underlyingId, underlyingId),
        lt(optionDailySignals.asOfDate, beforeDate),
        gte(optionDailySignals.asOfDate, sinceDate),
        sql`${optionDailySignals.iv30} is not null`,
      ),
    )
    .orderBy(sql`${optionDailySignals.asOfDate} desc`)
    .limit(limit);
  return rows.map((r) => Number(r.iv30));
}

/** Every stored signal per instrument (from `fromDate` on), sorted by date. */
export async function loadOptionSignals(
  db: Db,
  instrumentIds: readonly string[],
  fromDate?: string,
): Promise<Map<string, OptionSignal[]>> {
  const out = new Map<string, OptionSignal[]>();
  if (instrumentIds.length === 0) return out;
  const rows = await db
    .select()
    .from(optionDailySignals)
    .where(
      and(
        inArray(optionDailySignals.underlyingId, [...instrumentIds]),
        fromDate ? gte(optionDailySignals.asOfDate, fromDate) : sql`true`,
      ),
    )
    .orderBy(asc(optionDailySignals.asOfDate));
  for (const r of rows) {
    const values = Object.fromEntries(
      OPTION_SIGNAL_FIELDS.map((f) => [f, toNum(r[COLUMN[f]] as string | null)]),
    ) as OptionSignalValues;
    const list = out.get(r.underlyingId) ?? [];
    list.push({
      asOfDate: r.asOfDate,
      values,
      source: r.source as OptionSignalSource,
      ivHistoryDays: r.ivHistoryDays,
    });
    out.set(r.underlyingId, list);
  }
  return out;
}

/** The latest signal date per instrument, for the builder's picker. */
export async function latestOptionSignalDates(
  db: Db,
  instrumentIds?: readonly string[],
): Promise<Map<string, string>> {
  const rows = await db
    .select({
      id: optionDailySignals.underlyingId,
      latest: sql<string>`max(${optionDailySignals.asOfDate})::text`,
    })
    .from(optionDailySignals)
    .where(
      instrumentIds && instrumentIds.length > 0
        ? inArray(optionDailySignals.underlyingId, [...instrumentIds])
        : sql`true`,
    )
    .groupBy(optionDailySignals.underlyingId);
  return new Map(rows.map((r) => [r.id, r.latest]));
}

/** Whether a stored signal row exists for these days (the rebuild skips them). */
export async function signalDates(db: Db, underlyingId: string, sinceDate: string) {
  const rows = await db
    .select({ d: optionDailySignals.asOfDate, source: optionDailySignals.source })
    .from(optionDailySignals)
    .where(
      and(
        eq(optionDailySignals.underlyingId, underlyingId),
        gte(optionDailySignals.asOfDate, sinceDate),
      ),
    );
  return new Map(rows.map((r) => [r.d, r.source as OptionSignalSource]));
}

// ---------------------------------------------------------------------------
// Retention

/**
 * The rolling history (brief §3.5): deletes snapshot, signal and per-expiry
 * rows dated before `cutoffDate`. Contract rows are kept.
 */
export async function pruneOptionHistory(db: Database, cutoffDate: string) {
  return db.transaction(async (tx) => {
    const snapshots = await tx
      .delete(optionChainSnapshots)
      .where(lt(optionChainSnapshots.asOfDate, cutoffDate))
      .returning({ id: optionChainSnapshots.id });
    const signals = await tx
      .delete(optionDailySignals)
      .where(lt(optionDailySignals.asOfDate, cutoffDate))
      .returning({ id: optionDailySignals.id });
    const expiries = await tx
      .delete(optionExpirySignals)
      .where(lt(optionExpirySignals.asOfDate, cutoffDate))
      .returning({ d: optionExpirySignals.asOfDate });
    return { snapshots: snapshots.length, signals: signals.length, expiries: expiries.length };
  });
}

/** IV30 by day for one underlying from `sinceDate` on, oldest first. */
export async function iv30Series(db: Db, underlyingId: string, sinceDate: string) {
  const rows = await db
    .select({
      date: optionDailySignals.asOfDate,
      iv30: optionDailySignals.iv30,
      source: optionDailySignals.source,
    })
    .from(optionDailySignals)
    .where(
      and(
        eq(optionDailySignals.underlyingId, underlyingId),
        gte(optionDailySignals.asOfDate, sinceDate),
      ),
    )
    .orderBy(asc(optionDailySignals.asOfDate));
  return rows.map((r) => ({
    date: r.date,
    iv30: toNum(r.iv30),
    source: r.source as OptionSignalSource,
  }));
}

/** Rewrites a day's IV rank and percentile, e.g. once rebuilt history fills the year before it. */
export async function updateSignalRank(
  db: Db,
  underlyingId: string,
  asOfDate: string,
  rank: { rank: number | null; percentile: number | null; days: number },
) {
  await db
    .update(optionDailySignals)
    .set({
      ivRank252d: toStr(rank.rank),
      ivPercentile252d: toStr(rank.percentile),
      ivHistoryDays: rank.days,
    })
    .where(
      and(
        eq(optionDailySignals.underlyingId, underlyingId),
        eq(optionDailySignals.asOfDate, asOfDate),
      ),
    );
}

/** US stock and ETF instruments by symbol (the oldest listing of each), for the seed list. */
export async function underlyingsBySymbol(db: Db, symbols: readonly string[]) {
  if (symbols.length === 0) return new Map<string, string>();
  const rows = await db
    .select({ id: instruments.id, symbol: instruments.symbol })
    .from(instruments)
    .where(
      and(
        inArray(instruments.symbol, [...symbols]),
        inArray(instruments.assetClass, ['stock', 'etf']),
        eq(instruments.isDemo, false),
      ),
    )
    .orderBy(asc(instruments.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.symbol)) out.set(r.symbol, r.id);
  return out;
}

/**
 * The tenant's oldest active options feed (ADR 0047), else the sharing
 * admin's (N237, ADR 0084). Options data is keyless and recorded once for
 * everyone, so a shared one serves just like an own one.
 */
export async function activeOptionsFeed(tx: Db) {
  return (await ownOptionsFeed(tx)) ?? sharedOptionsFeed(tx);
}

async function sharedOptionsFeed(tx: Db) {
  const feed = (await sharedFeeds(tx)).find((f) => f.kind === 'options');
  return feed ? { id: feed.id, name: feed.name, provider: feed.provider } : undefined;
}

async function ownOptionsFeed(tx: Db) {
  const feeds = await tx
    .select({
      id: dataFeedConnections.id,
      name: dataFeedConnections.name,
      provider: dataFeedConnections.provider,
    })
    .from(dataFeedConnections)
    .where(eq(dataFeedConnections.isActive, true))
    .orderBy(asc(dataFeedConnections.createdAt));
  return feeds.find((f) => isOptionsProvider(f.provider));
}

/** An underlying the builder's options picker offers, with its latest signal date (brief §6). */
export interface OptionUnderlyingOption {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  venue: string;
  kind: 'tradable' | 'indicator_only';
  /** The as-of date of its latest end-of-day signal, or null before the first one. */
  latestAsOf: string | null;
}

/** The recorded universe as picker options, by symbol. */
export async function optionUnderlyingOptions(db: Db): Promise<OptionUnderlyingOption[]> {
  const rows = await db
    .select({
      id: instruments.id,
      symbol: instruments.symbol,
      displayName: instruments.displayName,
      assetClass: instruments.assetClass,
      venue: instruments.venue,
      kind: instruments.kind,
      latestAsOf: sql<
        string | null
      >`(select max(s.as_of_date)::text from option_daily_signal s where s.underlying_id = ${optionUniverse.underlyingId})`,
    })
    .from(optionUniverse)
    .innerJoin(instruments, eq(instruments.id, optionUniverse.underlyingId))
    .where(eq(optionUniverse.active, true))
    .orderBy(asc(instruments.symbol));
  return rows.map((r) => ({ ...r, kind: r.kind as OptionUnderlyingOption['kind'] }));
}

/**
 * The fallback for the options recording's Alpaca key (ADR 0050): each
 * platform admin's oldest active Alpaca feed with a stored credential, admins
 * oldest first. Worker only (tm_secrets); the caller opens the credential.
 */
export async function adminAlpacaFeeds(
  db: Database,
): Promise<{ userId: string; feedId: string; credentialId: string }[]> {
  const admins = await db.execute<{ user_id: string }>(
    sql`select user_id from options_key_admins()`,
  );
  const out: { userId: string; feedId: string; credentialId: string }[] = [];
  for (const { user_id: userId } of admins) {
    const feeds = await withTenant(db, { userId }, (tx) =>
      tx
        .select({ id: dataFeedConnections.id, credentialRef: dataFeedConnections.credentialRef })
        .from(dataFeedConnections)
        .where(
          and(eq(dataFeedConnections.provider, 'alpaca'), eq(dataFeedConnections.isActive, true)),
        )
        .orderBy(asc(dataFeedConnections.createdAt)),
    );
    const feed = feeds.find((f) => f.credentialRef);
    if (feed?.credentialRef)
      out.push({ userId, feedId: feed.id, credentialId: feed.credentialRef });
  }
  return out;
}
