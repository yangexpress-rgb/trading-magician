import {
  catalogueByCategory,
  FACTOR_CATALOGUE_V1,
  FACTOR_CATEGORIES,
  MIN_CROSS_SECTION,
  type FactorCategory,
  type FactorValues,
} from '@tm/domain';
import { asc, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { factorCoverage, factorSnapshots } from './schema';

/**
 * Pattern discovery's factor store (pattern brief §3, ADR 0091). Global
 * market data, written only by the worker's snapshot job, insert-only.
 */

type Db = Database | Transaction;

const CHUNK = 1000;

/** The coverage table's pseudo-factor that counts each day's snapshot rows. */
export const ROWS_FACTOR = '_rows';

export interface FactorSnapshotInput {
  instrumentId: string;
  asOf: string;
  values: FactorValues;
  closeRet: number | null;
  highRel: number | null;
  lowRel: number | null;
}

/** The latest snapshot date per instrument (absent: none yet). */
export async function latestSnapshotDates(
  db: Db,
  instrumentIds: readonly string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < instrumentIds.length; i += CHUNK) {
    const ids = instrumentIds.slice(i, i + CHUNK);
    const rows = await db
      .select({
        instrumentId: factorSnapshots.instrumentId,
        last: sql<string>`max(${factorSnapshots.asOf})::text`,
      })
      .from(factorSnapshots)
      .where(inArray(factorSnapshots.instrumentId, ids))
      .groupBy(factorSnapshots.instrumentId);
    for (const r of rows) out.set(r.instrumentId, r.last);
  }
  return out;
}

/**
 * Writes snapshot rows, skipping any already stored, and adds the rows it
 * did write to the coverage counts in the same transaction, so the counts
 * always match the rows. Returns how many were new.
 */
export async function saveFactorSnapshots(
  db: Database,
  rows: readonly FactorSnapshotInput[],
  catalogueVersion: number,
): Promise<number> {
  let written = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    written += await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(factorSnapshots)
        .values(
          chunk.map((r) => ({
            asOf: r.asOf,
            instrumentId: r.instrumentId,
            values: r.values,
            closeRet: r.closeRet,
            highRel: r.highRel,
            lowRel: r.lowRel,
            catalogueVersion,
          })),
        )
        .onConflictDoNothing()
        .returning({ asOf: factorSnapshots.asOf, instrumentId: factorSnapshots.instrumentId });
      if (inserted.length === 0) return 0;
      const fresh = new Set(inserted.map((r) => `${r.asOf}|${r.instrumentId}`));
      const counts = new Map<string, number>();
      const add = (factor: string, asOf: string) => {
        const k = `${factor}|${asOf}`;
        counts.set(k, (counts.get(k) ?? 0) + 1);
      };
      for (const r of chunk) {
        if (!fresh.has(`${r.asOf}|${r.instrumentId}`)) continue;
        add(ROWS_FACTOR, r.asOf);
        for (const f of Object.keys(r.values)) add(f, r.asOf);
      }
      const values = [...counts].map(([k, known]) => {
        const [factor, asOf] = k.split('|') as [string, string];
        return { factor, asOf, known };
      });
      for (let j = 0; j < values.length; j += CHUNK)
        await tx
          .insert(factorCoverage)
          .values(values.slice(j, j + CHUNK))
          .onConflictDoUpdate({
            target: [factorCoverage.factor, factorCoverage.asOf],
            set: { known: sql`${factorCoverage.known} + excluded.known` },
          });
      return inserted.length;
    });
  }
  return written;
}

export interface FactorCoverageLine {
  factor: string;
  /** The first day any instrument had a value. */
  firstAny: string | null;
  /** The first day at least MIN_CROSS_SECTION instruments had one: where quintile atoms can form. */
  firstCross: string | null;
  last: string | null;
  /** Instrument-days with a value. */
  known: number;
  /** Days with at least one value. */
  days: number;
}

export interface FactorCoverageReport {
  /** Snapshot rows, days and first/last day overall. */
  rows: number;
  days: number;
  first: string | null;
  last: string | null;
  /** Instruments with at least one row. */
  instruments: number;
  /** On-disk size of the snapshot table with its indexes, in bytes. */
  tableBytes: number;
  factors: FactorCoverageLine[];
  /** Per category: the earliest first-any and first-cross day across its factors. */
  categories: {
    category: FactorCategory;
    firstAny: string | null;
    firstCross: string | null;
    factors: number;
    factorsWithData: number;
  }[];
}

/** The backfill coverage report (brief §3, §13): per factor and category, where values begin. */
export async function factorCoverageReport(db: Db): Promise<FactorCoverageReport> {
  const lines = await db
    .select({
      factor: factorCoverage.factor,
      firstAny: sql<string | null>`min(${factorCoverage.asOf})::text`,
      firstCross: sql<
        string | null
      >`min(${factorCoverage.asOf}) filter (where ${factorCoverage.known} >= ${MIN_CROSS_SECTION})::text`,
      last: sql<string | null>`max(${factorCoverage.asOf})::text`,
      known: sql<number>`coalesce(sum(${factorCoverage.known}), 0)::bigint`,
      days: sql<number>`count(*)::int`,
    })
    .from(factorCoverage)
    .groupBy(factorCoverage.factor)
    .orderBy(asc(factorCoverage.factor));
  const byFactor = new Map(lines.map((l) => [l.factor, { ...l, known: Number(l.known) }]));
  const rowsLine = byFactor.get(ROWS_FACTOR);
  const [meta] = await db.execute<{ instruments: number; bytes: string }>(sql`
    select
      (select count(distinct instrument_id) from factor_snapshot)::int as instruments,
      pg_total_relation_size('factor_snapshot')::text as bytes`);
  const factors: FactorCoverageLine[] = FACTOR_CATALOGUE_V1.map(
    (f) =>
      byFactor.get(f.id) ?? {
        factor: f.id,
        firstAny: null,
        firstCross: null,
        last: null,
        known: 0,
        days: 0,
      },
  );
  const minOf = (xs: (string | null)[]) =>
    xs.filter((x): x is string => x !== null).sort()[0] ?? null;
  const groups = catalogueByCategory();
  return {
    rows: rowsLine?.known ?? 0,
    days: rowsLine?.days ?? 0,
    first: rowsLine?.firstAny ?? null,
    last: rowsLine?.last ?? null,
    instruments: Number(meta?.instruments ?? 0),
    tableBytes: Number(meta?.bytes ?? 0),
    factors,
    categories: FACTOR_CATEGORIES.map((category) => {
      const own = factors.filter((l) => groups[category].includes(l.factor));
      return {
        category,
        firstAny: minOf(own.map((l) => l.firstAny)),
        firstCross: minOf(own.map((l) => l.firstCross)),
        factors: own.length,
        factorsWithData: own.filter((l) => l.known > 0).length,
      };
    }),
  };
}
