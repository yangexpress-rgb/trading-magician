import { finraSymbolKey, type ShortInterestPoint } from '@tm/domain';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { instruments, shortInterest, shortInterestSettlement } from './schema';

/**
 * Storage for FINRA consolidated short interest (data inputs part 2, item B,
 * N323, ADR 0111). Public market data written only by the worker.
 */

type Db = Database | Transaction;

/** One published FINRA row, as the job parsed it. */
export interface ShortInterestRow {
  symbol: string;
  settlementDate: string;
  shortShares: number;
  previousShortShares: number | null;
  changeShares: number | null;
  avgDailyVolume: number | null;
  daysToCover: number | null;
  revisionFlag: string | null;
}

/**
 * The app's US stocks and ETFs by FINRA symbol key (BRK.B and BRKB both
 * resolve to BRKB). An exact symbol wins over a key match; demo instruments
 * never match.
 */
export async function shortInterestSymbols(db: Db): Promise<Map<string, string>> {
  const rows = await db
    .select({ id: instruments.id, symbol: instruments.symbol })
    .from(instruments)
    .where(
      and(
        inArray(instruments.assetClass, ['stock', 'etf']),
        eq(instruments.isDemo, false),
        eq(instruments.currency, 'USD'),
      ),
    )
    .orderBy(asc(instruments.createdAt));
  const exact = new Map<string, string>();
  const byKey = new Map<string, string>();
  for (const r of rows) {
    if (!exact.has(r.symbol)) exact.set(r.symbol, r.id);
    const k = finraSymbolKey(r.symbol);
    if (!byKey.has(k)) byKey.set(k, r.id);
  }
  // A FINRA symbol looks itself up exactly first, then by key.
  const out = new Map(byKey);
  for (const [symbol, id] of exact) out.set(symbol, id);
  return out;
}

export const resolveFinraSymbol = (map: ReadonlyMap<string, string>, symbol: string) =>
  map.get(symbol) ?? map.get(finraSymbolKey(symbol));

/**
 * Stores one settlement's rows for resolved instruments and records the
 * settlement (published, stored, the unresolved symbols). A row already
 * stored is replaced by the new figures (FINRA's revisions) but keeps its
 * first `available_date` and moves `recorded_at` only when a figure changed.
 */
export async function saveShortInterestSettlement(
  db: Database,
  settlementDate: string,
  availableDate: string,
  rows: readonly ShortInterestRow[],
  symbols: ReadonlyMap<string, string>,
): Promise<{ stored: number; changed: number; unresolved: string[] }> {
  const unresolved = new Set<string>();
  const byInstrument = new Map<string, ShortInterestRow>();
  for (const r of rows) {
    const id = resolveFinraSymbol(symbols, r.symbol);
    if (!id) {
      unresolved.add(r.symbol);
      continue;
    }
    // Two FINRA symbols on one instrument (BRK.B and BRKB): the exact one is kept.
    const prior = byInstrument.get(id);
    if (!prior || symbols.get(r.symbol) === id) byInstrument.set(id, r);
  }
  const num = (v: number | null) => (v === null ? null : String(v));
  const values = [...byInstrument].map(([instrumentId, r]) => ({
    instrumentId,
    settlementDate,
    availableDate,
    symbol: r.symbol,
    shortShares: String(r.shortShares),
    previousShortShares: num(r.previousShortShares),
    changeShares: num(r.changeShares),
    avgDailyVolume: num(r.avgDailyVolume),
    daysToCover: num(r.daysToCover),
    revisionFlag: r.revisionFlag,
  }));
  let changed = 0;
  await db.transaction(async (tx) => {
    for (let i = 0; i < values.length; i += 1000) {
      const done = await tx
        .insert(shortInterest)
        .values(values.slice(i, i + 1000))
        .onConflictDoUpdate({
          target: [shortInterest.instrumentId, shortInterest.settlementDate],
          // available_date is not in the set: a revision keeps the first publication date.
          set: {
            symbol: sql`excluded.symbol`,
            shortShares: sql`excluded.short_shares`,
            previousShortShares: sql`excluded.previous_short_shares`,
            changeShares: sql`excluded.change_shares`,
            avgDailyVolume: sql`excluded.avg_daily_volume`,
            daysToCover: sql`excluded.days_to_cover`,
            revisionFlag: sql`excluded.revision_flag`,
            recordedAt: sql`now()`,
          },
          setWhere: sql`(${shortInterest.shortShares}, ${shortInterest.previousShortShares}, ${shortInterest.changeShares}, ${shortInterest.avgDailyVolume}, ${shortInterest.daysToCover}, ${shortInterest.revisionFlag})
            is distinct from (excluded.short_shares, excluded.previous_short_shares, excluded.change_shares, excluded.avg_daily_volume, excluded.days_to_cover, excluded.revision_flag)`,
        })
        .returning({ id: shortInterest.instrumentId });
      changed += done.length;
    }
    const list = [...unresolved].sort();
    await tx
      .insert(shortInterestSettlement)
      .values({
        settlementDate,
        availableDate,
        published: rows.length,
        stored: values.length,
        unresolved: list.length,
        unresolvedSymbols: list,
      })
      .onConflictDoUpdate({
        target: shortInterestSettlement.settlementDate,
        // The first publication date stays, as for the rows.
        set: {
          published: rows.length,
          stored: values.length,
          unresolved: list.length,
          unresolvedSymbols: list,
          fetchedAt: sql`now()`,
        },
      });
  });
  return { stored: values.length, changed, unresolved: [...unresolved] };
}

/** The settlement dates the job has read, newest first. */
export async function storedSettlements(
  db: Db,
): Promise<
  { settlementDate: string; availableDate: string; stored: number; unresolved: number }[]
> {
  return db
    .select({
      settlementDate: shortInterestSettlement.settlementDate,
      availableDate: shortInterestSettlement.availableDate,
      stored: shortInterestSettlement.stored,
      unresolved: shortInterestSettlement.unresolved,
    })
    .from(shortInterestSettlement)
    .orderBy(desc(shortInterestSettlement.settlementDate));
}

/**
 * Stored settlements that listed a symbol which now resolves (an instrument
 * registered since): they are read again so its history is complete.
 */
export async function settlementsWithNewlyResolved(
  db: Db,
  symbols: ReadonlyMap<string, string>,
): Promise<string[]> {
  const rows = await db
    .select({
      settlementDate: shortInterestSettlement.settlementDate,
      unresolvedSymbols: shortInterestSettlement.unresolvedSymbols,
    })
    .from(shortInterestSettlement)
    .orderBy(desc(shortInterestSettlement.settlementDate));
  return rows
    .filter((r) =>
      r.unresolvedSymbols.some((sym) => resolveFinraSymbol(symbols, sym) !== undefined),
    )
    .map((r) => r.settlementDate);
}

/** Each instrument's rows, sorted by settlement date, for the metrics and factors. */
export async function loadShortInterest(
  db: Db,
  instrumentIds: readonly string[],
): Promise<Map<string, ShortInterestPoint[]>> {
  const out = new Map<string, ShortInterestPoint[]>();
  if (instrumentIds.length === 0) return out;
  const num = (v: string | null) => (v === null ? null : Number(v));
  for (let i = 0; i < instrumentIds.length; i += 1000) {
    const rows = await db
      .select()
      .from(shortInterest)
      .where(inArray(shortInterest.instrumentId, instrumentIds.slice(i, i + 1000)))
      .orderBy(asc(shortInterest.instrumentId), asc(shortInterest.settlementDate));
    for (const r of rows) {
      const list = out.get(r.instrumentId) ?? [];
      list.push({
        settlementDate: r.settlementDate,
        availableDate: r.availableDate,
        shortShares: Number(r.shortShares),
        previousShortShares: num(r.previousShortShares),
        changeShares: num(r.changeShares),
        avgDailyVolume: num(r.avgDailyVolume),
        daysToCover: num(r.daysToCover),
      });
      out.set(r.instrumentId, list);
    }
  }
  return out;
}

export interface ShortInterestCoverage {
  settlements: number;
  first: string | null;
  last: string | null;
  rows: number;
  /** Per calendar year of settlement: universe members with no FINRA row that year. */
  missingByYear: { year: number; settlements: number; members: number; missing: number }[];
}

/**
 * The backfill coverage report (B4): the settlement span, and per year how
 * many of `memberIds` (the research universe) have no stored row in any of
 * that year's settlements. Reported as found, never estimated.
 */
export async function shortInterestCoverage(
  db: Db,
  memberIds: readonly string[],
): Promise<ShortInterestCoverage> {
  const [span] = await db
    .select({
      settlements: sql<number>`count(*)::int`,
      first: sql<string | null>`min(${shortInterestSettlement.settlementDate})::text`,
      last: sql<string | null>`max(${shortInterestSettlement.settlementDate})::text`,
    })
    .from(shortInterestSettlement);
  const [rows] = await db.select({ n: sql<number>`count(*)::int` }).from(shortInterest);
  const perYear = await db.execute<{ year: number; settlements: number }>(sql`
    select extract(year from settlement_date)::int as year, count(*)::int as settlements
    from short_interest_settlement group by 1 order by 1`);
  const missingByYear: ShortInterestCoverage['missingByYear'] = [];
  const ids = [...new Set(memberIds)];
  for (const y of perYear) {
    let covered = 0;
    for (let i = 0; i < ids.length; i += 1000) {
      const chunk = ids.slice(i, i + 1000);
      const [c] = await db.execute<{ n: number }>(sql`
        select count(distinct instrument_id)::int as n from short_interest
        where extract(year from settlement_date) = ${y.year}
          and instrument_id in (${sql.join(
            chunk.map((id) => sql`${id}::uuid`),
            sql`, `,
          )})`);
      covered += Number(c?.n ?? 0);
    }
    missingByYear.push({
      year: Number(y.year),
      settlements: Number(y.settlements),
      members: ids.length,
      missing: ids.length - covered,
    });
  }
  return {
    settlements: Number(span?.settlements ?? 0),
    first: span?.first ?? null,
    last: span?.last ?? null,
    rows: Number(rows?.n ?? 0),
    missingByYear,
  };
}
