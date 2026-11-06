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
  /** `indicator_only` for an index: conditions may read it, legs can't trade it. */
  kind: 'tradable' | 'indicator_only';
}

export type LookupStatus = 'pending' | 'found' | 'not_found' | 'failed';

/** A listing the provider offered for a name search, not yet registered. */
export interface InstrumentCandidate {
  symbol: string;
  displayName: string;
  assetClass: string;
  venue: string;
}

export interface InstrumentLookupSummary {
  id: string;
  /** What the person typed. */
  symbol: string;
  status: LookupStatus;
  message: string | null;
  instrument: InstrumentOptionRow | null;
  candidates: InstrumentCandidate[];
  createdAt: string;
}

const SYMBOL = /^[A-Z][A-Z0-9.]{0,9}$/;
const MAX_PENDING = 5;
/** Letters, digits and the punctuation company names use. */
const QUERY = /^[\p{L}\p{N}][\p{L}\p{N} &.,'’-]*$/u;

const optionColumns = {
  id: instruments.id,
  symbol: instruments.symbol,
  displayName: instruments.displayName,
  assetClass: instruments.assetClass,
  venue: instruments.venue,
  kind: instruments.kind,
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
  // A ticker or a company name: tried as a ticker when it can be one, then by name.
  const query = input.symbol.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!QUERY.test(query)) {
    throw new IntegrationError('bad_request', 'Enter a ticker symbol or a company name');
  }
  const symbol = normalizeSymbol(query) ?? null;
  const [pending] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(instrumentLookups)
    .where(eq(instrumentLookups.status, 'pending'));
  if ((pending?.n ?? 0) >= MAX_PENDING) {
    throw new IntegrationError('conflict', 'Wait for your other lookups to finish');
  }
  const [row] = await tx
    .insert(instrumentLookups)
    .values({ userId: input.userId, symbol, query })
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
      query: instrumentLookups.query,
      status: instrumentLookups.status,
      message: instrumentLookups.message,
      instrumentId: instrumentLookups.instrumentId,
      candidates: instrumentLookups.candidates,
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
    symbol: row.symbol ?? row.query ?? '',
    status: row.status,
    message: row.message,
    instrument,
    candidates: (row.candidates as InstrumentCandidate[] | null) ?? [],
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
      query: instrumentLookups.query,
      attempts: instrumentLookups.attempts,
    })
    .from(instrumentLookups)
    .where(and(eq(instrumentLookups.id, id), eq(instrumentLookups.status, 'pending')));
  return row;
}

export interface ConfirmedInstrument {
  /** `index` only for an index the app knows, such as the VIX (v1.2 item 5). */
  assetClass: 'stock' | 'etf' | 'index';
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
    | { status: 'not_found'; message: string; candidates?: InstrumentCandidate[] }
    | { status: 'failed'; message: string }
    | { status: 'retry' },
): Promise<void> {
  // A retry keeps its lease, which then lapses and lets the lookup be claimed again.
  if (outcome.status === 'retry') return;
  await tx
    .update(instrumentLookups)
    .set(
      outcome.status === 'found'
        ? { status: 'found', instrumentId: outcome.instrumentId, message: null }
        : outcome.status === 'not_found'
          ? {
              status: 'not_found',
              message: outcome.message.slice(0, 200),
              candidates: (outcome.candidates ?? []).slice(0, 10).map((c) => ({
                symbol: c.symbol,
                displayName: c.displayName.slice(0, 200),
                assetClass: c.assetClass,
                venue: c.venue,
              })),
            }
          : { status: 'failed', message: outcome.message.slice(0, 200) },
    )
    .where(and(eq(instrumentLookups.id, id), eq(instrumentLookups.status, 'pending')));
}

/**
 * Registered real (non-demo) US stocks and ETFs by symbol, for resolving a
 * built-in universe such as the S&P 500 (Design v1.2 item 1). The first
 * listing per symbol wins.
 */
export async function instrumentsBySymbol(
  tx: Transaction,
  symbols: readonly string[],
): Promise<Map<string, string>> {
  if (symbols.length === 0) return new Map();
  const rows = await tx
    .select({ id: instruments.id, symbol: instruments.symbol })
    .from(instruments)
    .where(
      and(
        inArray(instruments.symbol, [...symbols]),
        inArray(instruments.assetClass, ['stock', 'etf']),
        eq(instruments.isDemo, false),
      ),
    )
    .orderBy(asc(instruments.symbol), asc(instruments.createdAt));
  const out = new Map<string, string>();
  for (const r of rows) if (!out.has(r.symbol)) out.set(r.symbol, r.id);
  return out;
}
