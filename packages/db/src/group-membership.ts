import { spanCovers, type MembershipSpan } from '@tm/domain';
import { and, asc, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { factorSnapshots, groupMembershipPeriod } from './schema';

/**
 * Point-in-time index membership (data inputs part 2, item C, N324, ADR 0112).
 * The worker writes the imported periods; back tests and the pattern factor
 * store read members as of each day.
 */

type Db = Database | Transaction;

export interface StoredMembershipPeriod {
  symbol: string;
  instrumentId: string | null;
  from: string;
  to: string | null;
}

export interface MembershipSyncResult {
  inserted: number;
  updated: number;
  deleted: number;
  unchanged: number;
}

/**
 * Makes the stored periods of a group match `periods` (the imported file,
 * resolved): new ones inserted, changed ones updated (their `recorded_at`
 * renewed), ones the file no longer has deleted. Running it again with the
 * same periods changes nothing.
 */
export async function syncMembershipPeriods(
  db: Database,
  input: { groupId: string; source: string; periods: readonly StoredMembershipPeriod[] },
): Promise<MembershipSyncResult> {
  const key = (p: { symbol: string; from: string }) => `${p.symbol}|${p.from}`;
  return db.transaction(async (tx) => {
    const stored = new Map(
      (await storedPeriods(tx, input.groupId)).map((p) => [key(p), p] as const),
    );
    const result: MembershipSyncResult = { inserted: 0, updated: 0, deleted: 0, unchanged: 0 };
    const inserts: (typeof groupMembershipPeriod.$inferInsert)[] = [];
    for (const p of input.periods) {
      const old = stored.get(key(p));
      stored.delete(key(p));
      if (!old) {
        inserts.push({
          groupId: input.groupId,
          symbol: p.symbol,
          instrumentId: p.instrumentId,
          fromDate: p.from,
          toDate: p.to,
          source: input.source,
        });
        continue;
      }
      if (old.to === p.to && old.instrumentId === p.instrumentId) {
        result.unchanged++;
        continue;
      }
      await tx
        .update(groupMembershipPeriod)
        .set({
          toDate: p.to,
          instrumentId: p.instrumentId,
          source: input.source,
          recordedAt: sql`now()`,
        })
        .where(
          and(
            eq(groupMembershipPeriod.groupId, input.groupId),
            eq(groupMembershipPeriod.symbol, p.symbol),
            eq(groupMembershipPeriod.fromDate, p.from),
          ),
        );
      result.updated++;
    }
    for (let i = 0; i < inserts.length; i += 500)
      await tx.insert(groupMembershipPeriod).values(inserts.slice(i, i + 500));
    result.inserted = inserts.length;
    for (const gone of stored.values()) {
      await tx
        .delete(groupMembershipPeriod)
        .where(
          and(
            eq(groupMembershipPeriod.groupId, input.groupId),
            eq(groupMembershipPeriod.symbol, gone.symbol),
            eq(groupMembershipPeriod.fromDate, gone.from),
          ),
        );
      result.deleted++;
    }
    return result;
  });
}

const columns = {
  symbol: groupMembershipPeriod.symbol,
  instrumentId: groupMembershipPeriod.instrumentId,
  from: groupMembershipPeriod.fromDate,
  to: groupMembershipPeriod.toDate,
};

/** Every stored period of a group, by symbol and start. */
export async function storedPeriods(db: Db, groupId: string): Promise<StoredMembershipPeriod[]> {
  return db
    .select(columns)
    .from(groupMembershipPeriod)
    .where(eq(groupMembershipPeriod.groupId, groupId))
    .orderBy(asc(groupMembershipPeriod.symbol), asc(groupMembershipPeriod.fromDate));
}

/** The periods of a group that overlap the days `from`..`to` (both included). */
export async function membershipPeriodsBetween(
  db: Db,
  groupId: string,
  from: string,
  to: string,
): Promise<StoredMembershipPeriod[]> {
  return db
    .select(columns)
    .from(groupMembershipPeriod)
    .where(
      and(
        eq(groupMembershipPeriod.groupId, groupId),
        lte(groupMembershipPeriod.fromDate, to),
        or(isNull(groupMembershipPeriod.toDate), gt(groupMembershipPeriod.toDate, from)),
      ),
    )
    .orderBy(asc(groupMembershipPeriod.symbol), asc(groupMembershipPeriod.fromDate));
}

/** The members of a group on `date`: each symbol then, with its instrument when resolved. */
export async function membersAsOf(
  db: Db,
  groupId: string,
  date: string,
): Promise<{ symbol: string; instrumentId: string | null }[]> {
  const rows = await membershipPeriodsBetween(db, groupId, date, date);
  return rows.map(({ symbol, instrumentId }) => ({ symbol, instrumentId }));
}

/** Whether a group has any stored periods (before the first import, groups read today's list). */
export async function hasMembershipHistory(db: Db, groupId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(groupMembershipPeriod)
    .where(eq(groupMembershipPeriod.groupId, groupId))
    .limit(1);
  return row !== undefined;
}

/** Per instrument, the spans it was a member, from stored periods with an instrument. */
export function spansByInstrument(
  periods: readonly StoredMembershipPeriod[],
): Map<string, MembershipSpan[]> {
  const out = new Map<string, MembershipSpan[]>();
  for (const p of periods) {
    if (!p.instrumentId) continue;
    const list = out.get(p.instrumentId) ?? [];
    list.push({ from: p.from, to: p.to });
    out.set(p.instrumentId, list);
  }
  return out;
}

export interface MembershipYear {
  year: number;
  /** Periods that overlap the year. */
  members: number;
  /** Of those, periods without an instrument (unresolved, or before the feed's history). */
  unresolved: number;
  /** Resolved periods the factor store holds no bars for inside the period that year. */
  noBars: number;
}

/**
 * Coverage by year (C5): for each year, how many of that year's members the
 * app can price. A resolved period counts as having bars that year when the
 * pattern factor store has a row for it on a day of the period in that year.
 */
export async function membershipCoverageByYear(
  db: Db,
  groupId: string,
  fromYear: number,
  toYear: number,
): Promise<MembershipYear[]> {
  const periods = await membershipPeriodsBetween(
    db,
    groupId,
    `${fromYear}-01-01`,
    `${toYear}-12-31`,
  );
  const ids = [...new Set(periods.flatMap((p) => (p.instrumentId ? [p.instrumentId] : [])))];
  // First and last stored day per instrument and year; a period with bars covers part of that.
  const spans = new Map<string, { first: string; last: string }>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const rows = await db
      .select({
        id: factorSnapshots.instrumentId,
        year: sql<number>`extract(year from ${factorSnapshots.asOf})::int`,
        first: sql<string>`min(${factorSnapshots.asOf})::text`,
        last: sql<string>`max(${factorSnapshots.asOf})::text`,
      })
      .from(factorSnapshots)
      .where(
        and(
          inArray(factorSnapshots.instrumentId, chunk),
          sql`${factorSnapshots.asOf} >= ${`${fromYear}-01-01`}`,
        ),
      )
      .groupBy(factorSnapshots.instrumentId, sql`2`);
    for (const r of rows) spans.set(`${r.id}|${r.year}`, { first: r.first, last: r.last });
  }
  const out: MembershipYear[] = [];
  for (let year = fromYear; year <= toYear; year++) {
    const start = `${year}-01-01`;
    const end = `${year}-12-31`;
    const row: MembershipYear = { year, members: 0, unresolved: 0, noBars: 0 };
    for (const p of periods) {
      if (!(p.from <= end && (p.to === null || p.to > start))) continue;
      row.members++;
      if (!p.instrumentId) {
        row.unresolved++;
        continue;
      }
      const s = spans.get(`${p.instrumentId}|${year}`);
      const lo = p.from > start ? p.from : start;
      const hi = p.to !== null && p.to <= end ? p.to : `${year + 1}-01-01`;
      // Bars that year, and some of them inside the period.
      if (!s || s.last < lo || s.first >= hi) row.noBars++;
    }
    out.push(row);
  }
  return out;
}

/** Whether an instrument was a member on `date`, from its spans. */
export const memberOn = (spans: readonly MembershipSpan[] | undefined, date: string) =>
  spans !== undefined && spans.some((s) => spanCovers(s, date));
