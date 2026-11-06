import {
  EQUITY_TOLERANCE,
  totalBooks,
  valueBooks,
  type BookValue,
  type BrokerAccountBalance,
  type Ledger,
  type Mark,
} from '@tm/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { Database, Transaction } from './client';
import { notify } from './notifications';
import {
  accountValuations,
  bookValuations,
  instruments,
  positionSnapshots,
  tradingAccounts,
} from './schema';

/**
 * Valuation and daily equity history (Design v1.0 §10.2; ADR 0020). Each
 * account is valued every few minutes: its ledger is marked at the routed
 * feed's prices and kept as one row per NYSE session, per account and per
 * book. The first valuation from a session's 4:00 pm close is final: it
 * snapshots the app's and the broker's positions and flags any quantity that
 * differs, or equity more than $1.00 apart. The broker is authoritative.
 */

export async function claimValuations(
  db: Database,
  options: { leaseSeconds: number; everySeconds: number; limit: number },
): Promise<{ accountId: string; userId: string }[]> {
  const rows = await db.execute<{ claimed_id: string; claimed_user: string }>(
    sql`select * from claim_valuations(${options.leaseSeconds}, ${options.everySeconds}, ${options.limit})`,
  );
  return rows.map((r) => ({ accountId: r.claimed_id, userId: r.claimed_user }));
}

export interface AccountToValue {
  id: string;
  nickname: string;
  startingEquity: string | null;
  /** Whether this session's final valuation is already recorded. */
  finalRecorded: boolean;
}

export async function loadAccountToValue(
  tx: Transaction,
  accountId: string,
  sessionDate: string,
): Promise<AccountToValue | undefined> {
  const [row] = await tx
    .select({
      id: tradingAccounts.id,
      nickname: tradingAccounts.nickname,
      startingEquity: tradingAccounts.startingEquity,
      final: accountValuations.final,
    })
    .from(tradingAccounts)
    .leftJoin(
      accountValuations,
      and(
        eq(accountValuations.accountId, tradingAccounts.id),
        eq(accountValuations.sessionDate, sessionDate),
      ),
    )
    .where(eq(tradingAccounts.id, accountId));
  if (!row) return undefined;
  return {
    id: row.id,
    nickname: row.nickname,
    startingEquity: row.startingEquity,
    finalRecorded: row.final === true,
  };
}

/** The instruments the ledger still holds, to ask the feed for their prices. */
export async function instrumentsToMark(
  tx: Transaction,
  ledger: Ledger,
): Promise<{ instrumentId: string; symbol: string }[]> {
  const ids = [...new Set(ledger.open.map((l) => l.instrumentId))];
  if (ids.length === 0) return [];
  return tx
    .select({ instrumentId: instruments.id, symbol: instruments.symbol })
    .from(instruments)
    .where(inArray(instruments.id, ids));
}

export interface PositionDifference {
  instrumentId: string;
  symbol: string;
  app: string;
  broker: string;
}

export interface ValuationInput {
  userId: string;
  account: AccountToValue;
  session: { date: string; final: boolean };
  now: Date;
  ledger: Ledger;
  marks: ReadonlyMap<string, Mark>;
  /** What the broker reported; absent when it could not be asked. */
  broker?:
    | {
        balance?: BrokerAccountBalance | undefined;
        positions?: ReadonlyMap<string, Decimal> | undefined;
      }
    | undefined;
}

export interface ValuationResult {
  appEquity: Decimal | null;
  brokerEquity: Decimal | null;
  difference: Decimal | null;
  positionDifferences: PositionDifference[];
  flagged: boolean;
  books: BookValue[];
  /** False when this session's final valuation was already recorded. */
  recorded: boolean;
}

const str = (d: Decimal) => d.toString();
const money = (d: Decimal) => d.toDecimalPlaces(2).toFixed(2);

export async function recordValuation(
  tx: Transaction,
  input: ValuationInput,
): Promise<ValuationResult> {
  const { userId, account, session, now } = input;
  const books = valueBooks(input.ledger, input.marks);
  const totals = totalBooks(books);
  const balance = input.broker?.balance;
  const brokerEquity = balance ? new Decimal(balance.equity) : null;

  // An account with no fixed starting equity takes it from the broker, the
  // first time the broker reports one, less what the app has made or lost.
  let starting = account.startingEquity === null ? null : new Decimal(account.startingEquity);
  if (starting === null && brokerEquity) {
    starting = brokerEquity.minus(totals.pnl);
    await tx
      .update(tradingAccounts)
      .set({ startingEquity: str(starting) })
      .where(eq(tradingAccounts.id, account.id));
  }
  const appEquity = starting ? starting.plus(totals.pnl) : null;
  const difference = brokerEquity && appEquity ? brokerEquity.minus(appEquity) : null;

  // At the close, compare what each side holds and keep both for the record.
  const positionDifferences: PositionDifference[] = [];
  const brokerPositions = input.broker?.positions;
  const compared = session.final && brokerPositions ? positionRows(books, brokerPositions) : [];
  const differing = compared.filter((p) => !p.app.equals(p.broker));
  if (differing.length > 0) {
    const ids = differing.map((p) => p.instrumentId).filter(isInstrumentId);
    const symbols = new Map(
      ids.length === 0
        ? []
        : (
            await tx
              .select({ id: instruments.id, symbol: instruments.symbol })
              .from(instruments)
              .where(inArray(instruments.id, ids))
          ).map((i) => [i.id, i.symbol]),
    );
    for (const p of differing) {
      positionDifferences.push({
        instrumentId: p.instrumentId,
        symbol: symbols.get(p.instrumentId) ?? brokerSymbol(p.instrumentId),
        app: str(p.app),
        broker: str(p.broker),
      });
    }
  }
  const equityOff = difference !== null && difference.abs().gt(EQUITY_TOLERANCE);
  const flagged = session.final && (equityOff || positionDifferences.length > 0);

  const changes = {
    asOf: now,
    final: session.final,
    startingEquity: starting ? str(starting) : null,
    appEquity: appEquity ? str(appEquity) : null,
    brokerEquity: brokerEquity ? str(brokerEquity) : null,
    brokerCash: balance ? balance.cash : null,
    realized: str(totals.realized),
    unrealized: str(totals.unrealized),
    fees: str(totals.fees),
    marketValue: str(totals.marketValue),
    staleMarks: totals.staleMarks,
    difference: difference ? str(difference) : null,
    positionDifferences,
    flagged,
  };
  const written = await tx
    .insert(accountValuations)
    .values({ userId, accountId: account.id, sessionDate: session.date, ...changes })
    .onConflictDoUpdate({
      target: [accountValuations.accountId, accountValuations.sessionDate],
      set: changes,
      // A final valuation is the record of that close (and a trigger guards it).
      setWhere: eq(accountValuations.final, false),
    })
    .returning({ id: accountValuations.id });
  const result = { appEquity, brokerEquity, difference, positionDifferences, flagged, books };
  if (written.length === 0) {
    await releaseValuation(tx, account.id);
    return { ...result, recorded: false };
  }

  // A holding the app has no instrument for yet cannot be snapshotted; it is still
  // listed in positionDifferences above.
  const known = compared.filter((p) => isInstrumentId(p.instrumentId));
  if (known.length > 0) {
    const snapshots = known.flatMap(({ instrumentId, app, broker }) => [
      { userId, accountId: account.id, instrumentId, quantity: str(app), source: 'app', asOf: now },
      {
        userId,
        accountId: account.id,
        instrumentId,
        quantity: str(broker),
        source: 'broker',
        asOf: now,
      },
    ]);
    if (snapshots.length > 0) await tx.insert(positionSnapshots).values(snapshots);
  }

  for (const b of books) {
    const set = {
      asOf: now,
      quantity: str(b.quantity),
      costBasis: str(b.costBasis),
      mark: b.mark ? str(b.mark.price) : null,
      markAt: b.mark?.at ?? null,
      markStale: !b.quantity.isZero() && (!b.mark || b.mark.stale),
      marketValue: str(b.marketValue),
      unrealized: str(b.unrealized),
      realized: str(b.realized),
      realizedGross: str(b.realizedGross),
      fees: str(b.fees),
      openFees: str(b.openFees),
    };
    await tx
      .insert(bookValuations)
      .values({
        userId,
        runtimeId: b.runtimeId,
        accountId: b.accountId,
        instrumentId: b.instrumentId,
        sessionDate: session.date,
        ...set,
      })
      .onConflictDoUpdate({
        target: [
          bookValuations.runtimeId,
          bookValuations.accountId,
          bookValuations.instrumentId,
          bookValuations.sessionDate,
        ],
        set,
      });
  }

  if (flagged) {
    const parts = positionDifferences
      .slice(0, 3)
      .map((p) => `${p.symbol}: app ${p.app}, broker ${p.broker}`);
    if (equityOff && difference && appEquity && brokerEquity) {
      parts.unshift(
        `Equity: app $${money(appEquity)}, broker $${money(brokerEquity)} (${difference.isNegative() ? '-' : '+'}$${money(difference.abs())})`,
      );
    }
    await notify(tx, {
      userId,
      kind: 'reconciliation_mismatch',
      title: `${account.nickname} differs from the broker at the close`,
      body: `${parts.join('; ')}. The broker's figures are the ones that count.`,
      link: `/performance?account=${account.id}`,
      resourceType: 'trading_account',
      resourceId: account.id,
      dedupeKey: `valuation:${account.id}:${session.date}`,
    });
  }

  await releaseValuation(tx, account.id);
  return { ...result, recorded: true };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A broker can hold a symbol the app has no instrument for yet (bought outside
 * the app). Its adapter then reports a stand-in id such as `alpaca:NKE`, which
 * is not an instrument row and must not be looked up or referenced as one.
 */
function isInstrumentId(id: string): boolean {
  return UUID.test(id);
}

/** The symbol in a stand-in id (`alpaca:NKE` → `NKE`), or `?`. */
function brokerSymbol(id: string): string {
  const colon = id.lastIndexOf(':');
  return colon >= 0 && colon < id.length - 1 ? id.slice(colon + 1) : '?';
}

/** Each instrument either side holds, with the app's and the broker's quantity. */
function positionRows(books: readonly BookValue[], broker: ReadonlyMap<string, Decimal>) {
  const app = new Map<string, Decimal>();
  for (const b of books) {
    app.set(b.instrumentId, (app.get(b.instrumentId) ?? new Decimal(0)).plus(b.quantity));
  }
  return [...new Set([...app.keys(), ...broker.keys()])]
    .map((instrumentId) => ({
      instrumentId,
      app: app.get(instrumentId) ?? new Decimal(0),
      broker: broker.get(instrumentId) ?? new Decimal(0),
    }))
    .filter((p) => !p.app.isZero() || !p.broker.isZero());
}

/** Ends a claim: the account is due again after the interval. */
export async function releaseValuation(tx: Transaction, accountId: string): Promise<void> {
  await tx
    .update(tradingAccounts)
    .set({ valuedAt: sql`now()`, valuationLeaseExpiresAt: null })
    .where(eq(tradingAccounts.id, accountId));
}

export interface EquityPoint {
  sessionDate: string;
  asOf: string;
  final: boolean;
  appEquity: string | null;
  brokerEquity: string | null;
  difference: string | null;
  staleMarks: number;
  flagged: boolean;
}

/** An account's equity history, oldest first. */
export async function listAccountValuations(
  tx: Transaction,
  accountId: string,
): Promise<EquityPoint[]> {
  const rows = await tx
    .select()
    .from(accountValuations)
    .where(eq(accountValuations.accountId, accountId))
    .orderBy(accountValuations.sessionDate);
  return rows.map((r) => ({
    sessionDate: r.sessionDate,
    asOf: r.asOf.toISOString(),
    final: r.final,
    appEquity: r.appEquity,
    brokerEquity: r.brokerEquity,
    difference: r.difference,
    staleMarks: r.staleMarks,
    flagged: r.flagged,
  }));
}
