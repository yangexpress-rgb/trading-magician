import {
  buildLedger,
  cycleResults,
  type ClosedLot,
  type Ledger,
  type LedgerFill,
  type LotSide,
  type OpenLot,
} from '@tm/domain';
import { and, eq, inArray, type SQL } from 'drizzle-orm';
import Decimal from 'decimal.js';
import type { Transaction } from './client';
import {
  fills,
  instruments,
  orderIntents,
  strategies,
  strategyCycles,
  strategyRuntimes,
  strategyVersions,
  tradingAccounts,
} from './schema';

/**
 * Performance from reconciled fills (Design v1.0 §10; ADR 0019). Every fill
 * the app holds is matched first in, first out within its book (one per
 * strategy runtime, account and instrument); results are grouped by the
 * strategy cycle that opened each lot.
 */

export interface LedgerScope {
  strategyIds?: readonly string[] | undefined;
  accountIds?: readonly string[] | undefined;
  instrumentIds?: readonly string[] | undefined;
  mode?: 'paper' | 'live' | undefined;
}

export interface FillContext {
  strategyId: string;
  versionId: string;
  mode: 'paper' | 'live';
  symbol: string;
  assetClass: string;
}

/**
 * Loads every fill in scope with what the ledger needs. Scope narrows whole
 * books only, never by date, so lots always match against their full history.
 */
export async function loadLedger(
  tx: Transaction,
  scope: LedgerScope = {},
): Promise<{ ledger: Ledger; context: Map<string, FillContext> }> {
  const where: SQL[] = [];
  if (scope.strategyIds) where.push(inArray(orderIntents.strategyId, [...scope.strategyIds]));
  if (scope.accountIds) where.push(inArray(orderIntents.accountId, [...scope.accountIds]));
  if (scope.instrumentIds) where.push(inArray(orderIntents.instrumentId, [...scope.instrumentIds]));
  if (scope.mode) where.push(eq(orderIntents.mode, scope.mode));
  const empty =
    scope.strategyIds?.length === 0 ||
    scope.accountIds?.length === 0 ||
    scope.instrumentIds?.length === 0;
  const rows = empty
    ? []
    : await tx
        .select({
          id: fills.id,
          quantity: fills.quantity,
          price: fills.price,
          fee: fills.fee,
          filledAt: fills.filledAt,
          runtimeId: orderIntents.runtimeId,
          accountId: orderIntents.accountId,
          instrumentId: orderIntents.instrumentId,
          cycleId: orderIntents.cycleId,
          legLabel: orderIntents.legLabel,
          direction: orderIntents.direction,
          strategyId: orderIntents.strategyId,
          versionId: orderIntents.versionId,
          mode: orderIntents.mode,
          multiplier: instruments.multiplier,
          symbol: instruments.symbol,
          assetClass: instruments.assetClass,
        })
        .from(fills)
        .innerJoin(orderIntents, eq(orderIntents.id, fills.intentId))
        .innerJoin(instruments, eq(instruments.id, orderIntents.instrumentId))
        .where(where.length > 0 ? and(...where) : undefined);

  const context = new Map<string, FillContext>();
  const ledgerFills: LedgerFill[] = rows.map((r) => {
    context.set(r.id, {
      strategyId: r.strategyId,
      versionId: r.versionId,
      mode: r.mode,
      symbol: r.symbol,
      assetClass: r.assetClass,
    });
    return {
      id: r.id,
      runtimeId: r.runtimeId,
      accountId: r.accountId,
      instrumentId: r.instrumentId,
      cycleId: r.cycleId,
      legLabel: r.legLabel,
      direction: r.direction === 'sell' ? 'sell' : 'buy',
      quantity: new Decimal(r.quantity),
      price: new Decimal(r.price),
      fee: new Decimal(r.fee),
      multiplier: new Decimal(r.multiplier),
      filledAt: r.filledAt,
    };
  });
  return { ledger: buildLedger(ledgerFills), context };
}

export interface TradeLeg {
  legLabel: string;
  accountId: string;
  accountName: string;
  instrumentId: string;
  symbol: string;
  side: LotSide;
  opened: string;
  closed: string;
  averageOpen: string;
  averageClose: string | null;
  gross: string;
  fees: string;
  net: string;
}

export interface CycleTrade {
  cycleId: string;
  seq: number;
  strategyId: string;
  strategyName: string;
  versionNo: number;
  runtimeId: string;
  mode: 'paper' | 'live';
  openedAt: string;
  /** Null while any of its lots is open. */
  closedAt: string | null;
  gross: string;
  fees: string;
  net: string;
  /** Cost of everything the cycle opened. */
  capital: string;
  /** Net as a percentage of capital, to two places; null without capital. */
  returnPct: string | null;
  legs: TradeLeg[];
}

const money = (d: Decimal) => d.toDecimalPlaces(2).toFixed(2);
const qty = (d: Decimal) => d.toDecimalPlaces(8).toString();
const price = (d: Decimal) => d.toDecimalPlaces(4).toString();

/** One trade per strategy cycle, newest first, with each leg's part (§10.2). */
export async function listCycleTrades(
  tx: Transaction,
  scope: LedgerScope & {
    /** Trades closed (or, while open, opened) on or after `from` and before `to`. */
    from?: Date | undefined;
    to?: Date | undefined;
    versionIds?: readonly string[] | undefined;
  } = {},
): Promise<CycleTrade[]> {
  const { ledger } = await loadLedger(tx, scope);
  const results = cycleResults(ledger).filter((c) => {
    const when = c.closedAt ?? c.openedAt;
    return (!scope.from || when >= scope.from) && (!scope.to || when < scope.to);
  });
  if (results.length === 0) return [];

  const cycleRows = await tx
    .select({
      id: strategyCycles.id,
      seq: strategyCycles.seq,
      runtimeId: strategyCycles.runtimeId,
      strategyId: strategyRuntimes.strategyId,
      versionId: strategyRuntimes.versionId,
      mode: strategyRuntimes.mode,
      strategyName: strategies.name,
      versionNo: strategyVersions.versionNo,
    })
    .from(strategyCycles)
    .innerJoin(strategyRuntimes, eq(strategyRuntimes.id, strategyCycles.runtimeId))
    .innerJoin(strategies, eq(strategies.id, strategyRuntimes.strategyId))
    .innerJoin(strategyVersions, eq(strategyVersions.id, strategyRuntimes.versionId))
    .where(
      inArray(
        strategyCycles.id,
        results.map((r) => r.cycleId),
      ),
    );
  const cycles = new Map(cycleRows.map((c) => [c.id, c]));
  const names = await lookupNames(tx, results);

  return results
    .flatMap((r): CycleTrade[] => {
      const c = cycles.get(r.cycleId);
      if (!c) return [];
      if (scope.versionIds && !scope.versionIds.includes(c.versionId)) return [];
      return [
        {
          cycleId: r.cycleId,
          seq: c.seq,
          strategyId: c.strategyId,
          strategyName: c.strategyName,
          versionNo: c.versionNo,
          runtimeId: r.runtimeId,
          mode: c.mode,
          openedAt: r.openedAt.toISOString(),
          closedAt: r.closedAt?.toISOString() ?? null,
          gross: money(r.gross),
          fees: money(r.fees),
          net: money(r.net),
          capital: money(r.capital),
          returnPct: r.capital.isZero() ? null : r.net.div(r.capital).times(100).toFixed(2),
          legs: r.legs.map((l) => ({
            legLabel: l.legLabel,
            accountId: l.accountId,
            accountName: names.accounts.get(l.accountId) ?? 'Removed account',
            instrumentId: l.instrumentId,
            symbol: names.symbols.get(l.instrumentId) ?? '?',
            side: l.side,
            opened: qty(l.opened),
            closed: qty(l.closed),
            averageOpen: price(l.averageOpen),
            averageClose: l.averageClose ? price(l.averageClose) : null,
            gross: money(l.gross),
            fees: money(l.fees),
            net: money(l.net),
          })),
        },
      ];
    })
    .sort((a, b) => (b.closedAt ?? b.openedAt).localeCompare(a.closedAt ?? a.openedAt));
}

async function lookupNames(
  tx: Transaction,
  results: { legs: { accountId: string; instrumentId: string }[] }[],
) {
  const accountIds = [...new Set(results.flatMap((r) => r.legs.map((l) => l.accountId)))];
  const instrumentIds = [...new Set(results.flatMap((r) => r.legs.map((l) => l.instrumentId)))];
  const accounts =
    accountIds.length === 0
      ? []
      : await tx
          .select({ id: tradingAccounts.id, name: tradingAccounts.nickname })
          .from(tradingAccounts)
          .where(inArray(tradingAccounts.id, accountIds));
  const symbols =
    instrumentIds.length === 0
      ? []
      : await tx
          .select({ id: instruments.id, symbol: instruments.symbol })
          .from(instruments)
          .where(inArray(instruments.id, instrumentIds));
  return {
    accounts: new Map(accounts.map((a) => [a.id, a.name])),
    symbols: new Map(symbols.map((s) => [s.id, s.symbol])),
  };
}

export type { ClosedLot, OpenLot };
