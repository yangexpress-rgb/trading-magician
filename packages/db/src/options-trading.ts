import {
  contractListVersion,
  coveredStructures,
  hasCombo,
  isOptionLeg,
  type ContractListEntry,
  parseOptionsLevel,
  type OptionsAccountView,
  type OptionsUse,
  type StrategyDefinition,
} from '@tm/domain';
import { and, asc, eq, gte, ne, sql } from 'drizzle-orm';
import type { Transaction } from './client';
import {
  brokerConnections,
  brokerOrders,
  optionContractLists,
  optionDividends,
  orderEvents,
  strategyRuntimes,
  tradingAccounts,
} from './schema';

/**
 * Options trading in the database (options brief v0.2, ADR 0123): contracts as
 * instrument rows, and the account facts the options Start gates read.
 */

export interface OptionContractInput {
  underlyingId: string;
  /** OCC symbol, e.g. AAPL251226C00105000. */
  symbol: string;
  expiry: string;
  strike: string;
  right: 'call' | 'put';
  /** As the broker reports it; the resolver accepts only 100 (§5.3). */
  multiplier: string;
  provider: string;
  providerId: string;
}

/**
 * Worker only (tm_secrets): the instrument row of an option contract,
 * inserted or found on the instrument identity key (§5.3). Safe when two runs
 * resolve the same contract at the same moment: both get the same id.
 */
export async function ensureOptionInstrument(
  tx: Transaction,
  c: OptionContractInput,
): Promise<string> {
  const [row] = await tx.execute<{ id: string }>(
    sql`select register_option_contract(${c.underlyingId}::uuid, ${c.symbol}, ${c.expiry}::date, ${c.strike}::numeric, ${c.right}::option_right, ${c.multiplier}::numeric, ${c.provider}, ${c.providerId}) as id`,
  );
  if (!row) throw new Error('option contract registration failed');
  return row.id;
}

/** What a strategy does with options, for the Start gates (§5.4); empty for stocks and ETFs. */
export function optionsUses(def: StrategyDefinition): OptionsUse[] {
  const legs = [...def.entry.orders, ...def.exit.orders].filter(isOptionLeg);
  if (legs.length === 0) return [];
  const uses = new Set<OptionsUse>();
  // Buying to open is a long option (level 2); an Entry with no options leg reads as one too.
  if (
    def.entry.orders.some((o) => isOptionLeg(o) && o.side === 'buy') ||
    !def.entry.orders.some(isOptionLeg)
  )
    uses.add('long');
  // Two or more options legs on one underlying, or any sold to open, are a combo (§§3, 5.4)...
  if (hasCombo(def)) uses.add('combo');
  // ...except a call covered by the Entry's shares or a cash-secured put (level 1, Phase O3).
  if (coveredStructures(def.entry.orders).length > 0) uses.add('covered');
  return [...uses];
}

/** Whether a definition has any options leg (§5.6). */
export const tradesOptions = (def: StrategyDefinition) => optionsUses(def).length > 0;

/**
 * The account as the options Start gates see it (§§5.4–5.6): its mode, whether
 * it is the simulator, the options level the broker last reported, and what
 * its other runs trade (stopped runs don't count).
 */
export async function optionsAccountView(
  tx: Transaction,
  accountId: string,
): Promise<OptionsAccountView> {
  const [a] = await tx
    .select({
      nickname: tradingAccounts.nickname,
      mode: tradingAccounts.mode,
      level: tradingAccounts.brokerOptionsLevel,
      provider: brokerConnections.provider,
    })
    .from(tradingAccounts)
    .innerJoin(brokerConnections, eq(brokerConnections.id, tradingAccounts.brokerConnectionId))
    .where(eq(tradingAccounts.id, accountId));
  if (!a) throw new Error('unknown account');
  const runs = await tx
    .select({ options: strategyRuntimes.tradesOptions, n: sql<number>`count(*)::int` })
    .from(strategyRuntimes)
    .where(and(eq(strategyRuntimes.accountId, accountId), ne(strategyRuntimes.status, 'stopped')))
    .groupBy(strategyRuntimes.tradesOptions);
  return {
    nickname: a.nickname,
    mode: a.mode,
    simulator: a.provider === 'demo',
    optionsLevel: parseOptionsLevel(a.level),
    hasOptionsRuns: runs.some((r) => r.options && r.n > 0),
    hasEquityRuns: runs.some((r) => !r.options && r.n > 0),
  };
}

/** Whether a non-stopped run on the account trades options (§5.6): the lifecycle job's accounts. */
export async function isOptionsAccount(tx: Transaction, accountId: string): Promise<boolean> {
  const [row] = await tx
    .select({ id: strategyRuntimes.id })
    .from(strategyRuntimes)
    .where(
      and(
        eq(strategyRuntimes.accountId, accountId),
        eq(strategyRuntimes.tradesOptions, true),
        ne(strategyRuntimes.status, 'stopped'),
      ),
    )
    .limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// §6.3 The contract list, cached in Core
// ---------------------------------------------------------------------------

export interface CachedContractList {
  underlyingId: string;
  fetchedOn: string;
  fetchedAt: Date;
  version: string;
  expiryTo: string;
  strikeFrom: string;
  strikeTo: string;
  contracts: ContractListEntry[];
}

/** Worker only: the cached list of an underlying, or undefined while none was read. */
export async function loadContractList(
  tx: Transaction,
  underlyingId: string,
): Promise<CachedContractList | undefined> {
  const [row] = await tx
    .select()
    .from(optionContractLists)
    .where(eq(optionContractLists.underlyingId, underlyingId));
  return row ? { ...row, contracts: row.contracts as ContractListEntry[] } : undefined;
}

/** Worker only: replaces an underlying's cached list (§6.3). */
export async function saveContractList(
  tx: Transaction,
  list: Omit<CachedContractList, 'version'>,
): Promise<CachedContractList> {
  const version = contractListVersion(list.fetchedOn, list.contracts);
  const row = { ...list, version };
  await tx
    .insert(optionContractLists)
    .values(row)
    .onConflictDoUpdate({ target: optionContractLists.underlyingId, set: row });
  return row;
}

/**
 * Worker only (§7.5, Phase O2): an underlying's announced cash dividends, as
 * read today. Rows already known are refreshed; none are removed, since a
 * past ex-date is never read again.
 */
export async function saveOptionDividends(
  tx: Transaction,
  underlyingId: string,
  fetchedOn: string,
  rows: readonly { exDate: string; cashAmount: string }[],
): Promise<void> {
  for (const r of rows)
    await tx
      .insert(optionDividends)
      .values({ underlyingId, fetchedOn, ...r })
      .onConflictDoUpdate({
        target: [optionDividends.underlyingId, optionDividends.exDate],
        set: { cashAmount: r.cashAmount, fetchedOn },
      });
}

/** Worker only (§7.5): the next ex-dividend date on or after `onOrAfter`, with its cash per share. */
export async function nextOptionDividend(
  tx: Transaction,
  underlyingId: string,
  onOrAfter: string,
): Promise<{ exDate: string; cashAmount: string } | undefined> {
  const [row] = await tx
    .select({ exDate: optionDividends.exDate, cashAmount: optionDividends.cashAmount })
    .from(optionDividends)
    .where(
      and(eq(optionDividends.underlyingId, underlyingId), gte(optionDividends.exDate, onOrAfter)),
    )
    .orderBy(asc(optionDividends.exDate))
    .limit(1);
  return row;
}

/**
 * Worker only (§7.1): an options order re-priced in place. The broker gave it
 * a new order id; the intent keeps its own client order id (with `_r` at the
 * broker), and the order's timeline shows the new limit and its quote.
 */
export async function recordReprice(
  tx: Transaction,
  intentId: string,
  change: {
    brokerOrderId: string;
    limitPrice: string;
    quote: { bid: string; ask: string; at: string };
  },
): Promise<void> {
  const [row] = await tx
    .update(brokerOrders)
    .set({ brokerOrderId: change.brokerOrderId, updatedAt: new Date() })
    .where(eq(brokerOrders.intentId, intentId))
    .returning({ userId: brokerOrders.userId, state: brokerOrders.state });
  if (!row) throw new Error('unknown order');
  await tx.insert(orderEvents).values({
    userId: row.userId,
    intentId,
    source: 'app',
    fromState: row.state,
    toState: row.state,
    payload: { kind: 'option_reprice', ...change },
  });
}
