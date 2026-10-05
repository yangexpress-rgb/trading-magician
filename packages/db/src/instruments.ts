import { and, asc, eq, inArray, or, sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { IntegrationError } from './feeds';
import { instrumentLookups, instruments, strategyInstruments } from './schema';

/**
 * Real instruments (ADR 0017). People look up a US stock or ETF by symbol; the
 * worker confirms it with the tenant's data provider and registers it in the
 * shared instrument table, which the web login can only read.
 */

export interface InstrumentOptionRow {
  id: string;
  symbol: string;
  displayName: string;
  assetClass: string;
  venue: string;
}

export type LookupStatus = 'pending' | 'found' | 'not_found' | 'failed';

export interface InstrumentLookupSummary {
  id: string;
  symbol: string;
  status: LookupStatus;
  message: string | null;
  instrument: InstrumentOptionRow | null;
  createdAt: string;
}

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const MAX_PENDING = 5;

const optionColumns = {
  id: instruments.id,
  symbol: instruments.symbol,
  displayName: instruments.displayName,
  assetClass: instruments.assetClass,
  venue: instruments.venue,
};

/**
 * The instruments a tenant can pick: the demo ones, those it looked up, and
 * those its strategies already use. Other tenants' lookups stay private.
 */
export async function listTenantInstruments(tx: Transaction): Promise<InstrumentOptionRow[]> {
  const found = tx
    .select({ id: instrumentLookups.instrumentId })
    .from(instrumentLookups)
    .where(eq(instrumentLookups.status, 'found'));
  const used = tx.select({ id: strategyInstruments.instrumentId }).from(strategyInstruments);
  return tx
    .select(optionColumns)
    .from(instruments)
    .where(
      or(
        eq(instruments.isDemo, true),
        inArray(instruments.id, found),
        inArray(instruments.id, used),
      ),
    )
    .orderBy(asc(instruments.symbol), asc(instruments.venue));
}

export function normalizeSymbol(raw: string): string | undefined {
  const symbol = raw.trim().toUpperCase();
  return SYMBOL.test(symbol) ? symbol : undefined;
}

export async function requestInstrumentLookup(
  tx: Transaction,
  input: { userId: string; symbol: string },
): Promise<InstrumentLookupSummary> {
  const symbol = normalizeSymbol(input.symbol);
  if (!symbol) {
    throw new IntegrationError('bad_request', 'Enter a ticker symbol, such as the letters ABC');
  }
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(instrumentLookups)
    .where(eq(instrumentLookups.status, 'pending'));
  if ((pending?.n ?? 0) >= MAX_PENDING) {
    throw new IntegrationError('conflict', 'Wait for your other lookups to finish');
  }
  const [row] = await tx
    .insert(instrumentLookups)
    .values({ userId: input.userId, symbol })
    .returning({ id: instrumentLookups.id });
  if (!row) throw new Error('lookup insert failed');
  return getInstrumentLookup(tx, row.id);
}

export async function getInstrumentLookup(
  tx: Transaction,
  id: string,
): Promise<InstrumentLookupSummary> {
  const [row] = await tx
    .select({
      id: instrumentLookups.id,
      symbol: instrumentLookups.symbol,
      status: instrumentLookups.status,
      message: instrumentLookups.message,
      instrumentId: instrumentLookups.instrumentId,
      createdAt: instrumentLookups.createdAt,
    })
    .from(instrumentLookups)
    .where(eq(instrumentLookups.id, id));
  if (!row) throw new IntegrationError('not_found', 'No such lookup');
  let instrument: InstrumentOptionRow | null = null;
  if (row.instrumentId) {
    [instrument = null] = await tx
      .select(optionColumns)
      .from(instruments)
      .where(eq(instruments.id, row.instrumentId));
  }
  return {
    id: row.id,
    symbol: row.symbol,
    status: row.status,
    message: row.message,
    instrument,
    createdAt: row.createdAt.toISOString(),
  };
}

// --- Worker side -------------------------------------------------------------

export async function claimInstrumentLookups(
  db: Database,
  options: { leaseSeconds: number; limit: number },
): Promise<{ lookupId: string; userId: string }[]> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_instrument_lookups(${options.leaseSeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ lookupId: r.claimed_id, userId: r.claimed_user }));
}

export async function loadPendingLookup(tx: Transaction, id: string) {
  const [row] = await tx
    .select({
      id: instrumentLookups.id,
      symbol: instrumentLookups.symbol,
      attempts: instrumentLookups.attempts,
    })
    .from(instrumentLookups)
    .where(and(eq(instrumentLookups.id, id), eq(instrumentLookups.status, 'pending')));
  return row;
}

export interface ConfirmedInstrument {
  assetClass: 'stock' | 'etf';
  symbol: string;
  venue: string;
  displayName: string;
  provider: string;
  providerId: string;
}

/** Worker only (tm_secrets): adds or refreshes a provider-confirmed instrument. */
export async function registerInstrument(
  tx: Transaction,
  found: ConfirmedInstrument,
): Promise<string> {
  const [row] = await tx.execute<{ id: string }>(
    sql`select register_instrument(${found.assetClass}::asset_class, ${found.symbol}, ${found.venue}, ${found.displayName}, ${found.provider}, ${found.providerId}) as id`,
  );
  if (!row) throw new Error('instrument registration failed');
  return row.id;
}

export async function finishLookup(
  tx: Transaction,
  id: string,
  outcome:
    | { status: 'found'; instrumentId: string }
    | { status: 'not_found' | 'failed'; message: string }
    | { status: 'retry' },
): Promise<void> {
  // A retry keeps its lease, which then lapses and lets the lookup be claimed again.
  if (outcome.status === 'retry') return;
  await tx
    .update(instrumentLookups)
    .set(
      outcome.status === 'found'
        ? { status: 'found', instrumentId: outcome.instrumentId, message: null }
        : { status: outcome.status, message: outcome.message.slice(0, 200) },
    )
    .where(and(eq(instrumentLookups.id, id), eq(instrumentLookups.status, 'pending')));
}
