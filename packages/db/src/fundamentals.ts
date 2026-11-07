import { sortObservations, type FundamentalField, type FundamentalObservation } from '@tm/domain';
import { asc, inArray, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { fundamentalCompanies, fundamentalObservations } from './schema';

/**
 * Point-in-time fundamentals (Design v1.2 item 6, ADR 0043), kept once for
 * every tenant. Worker only: the tables are granted to tm_secrets alone.
 */

type Db = Database | Transaction;

export interface FundamentalCompanySync {
  cik: number;
  symbol: string;
  syncedAt: Date;
  status: 'ok' | 'missing';
}

/** When each company was last synced from EDGAR. */
export async function fundamentalSyncTimes(db: Db, ciks: number[]): Promise<Map<number, Date>> {
  if (ciks.length === 0) return new Map();
  const rows = await db
    .select({ cik: fundamentalCompanies.cik, syncedAt: fundamentalCompanies.syncedAt })
    .from(fundamentalCompanies)
    .where(inArray(fundamentalCompanies.cik, ciks));
  return new Map(rows.map((r) => [r.cik, r.syncedAt]));
}

/**
 * Records a sync and adds the observations it found. An observation is
 * fixed once its filing is accepted, so one already stored is kept as it is.
 */
export async function saveFundamentals(
  db: Db,
  company: FundamentalCompanySync,
  observations: readonly FundamentalObservation[],
): Promise<void> {
  await db
    .insert(fundamentalCompanies)
    .values(company)
    .onConflictDoUpdate({
      target: fundamentalCompanies.cik,
      set: { symbol: company.symbol, syncedAt: company.syncedAt, status: company.status },
    });
  for (let i = 0; i < observations.length; i += 1000) {
    const chunk = observations.slice(i, i + 1000);
    await db
      .insert(fundamentalObservations)
      .values(
        chunk.map((o) => ({
          cik: company.cik,
          field: o.field,
          value: o.value,
          periodEnd: o.periodEnd,
          availableFrom: new Date(o.availableFrom),
          accession: o.accession,
          form: o.form,
        })),
      )
      .onConflictDoNothing();
  }
}

/** Every stored observation per company, sorted for `latestObservation`. */
export async function loadFundamentals(
  db: Db,
  ciks: number[],
): Promise<Map<number, FundamentalObservation[]>> {
  const out = new Map<number, FundamentalObservation[]>();
  if (ciks.length === 0) return out;
  const rows = await db
    .select({
      cik: fundamentalObservations.cik,
      field: fundamentalObservations.field,
      value: sql<string>`${fundamentalObservations.value}::text`,
      periodEnd: fundamentalObservations.periodEnd,
      availableFrom: fundamentalObservations.availableFrom,
      accession: fundamentalObservations.accession,
      form: fundamentalObservations.form,
    })
    .from(fundamentalObservations)
    .where(inArray(fundamentalObservations.cik, ciks))
    .orderBy(asc(fundamentalObservations.availableFrom));
  for (const r of rows) {
    const list = out.get(r.cik) ?? [];
    list.push({
      field: r.field as FundamentalField,
      value: r.value,
      periodEnd: r.periodEnd,
      availableFrom: r.availableFrom.toISOString(),
      accession: r.accession,
      form: r.form,
    });
    out.set(r.cik, list);
  }
  for (const list of out.values()) sortObservations(list);
  return out;
}
