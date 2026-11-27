import {
  isOptionLeg,
  parseOptionsLevel,
  type OptionsAccountView,
  type OptionsUse,
  type StrategyDefinition,
} from '@tm/domain';
import { and, eq, ne, sql } from 'drizzle-orm';
import type { Transaction } from './client';
import { brokerConnections, strategyRuntimes, tradingAccounts } from './schema';

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
  const uses = new Set<OptionsUse>(['long']);
  // A sell-to-open options leg only exists inside a combo (§7.3); O1 refuses them at validation.
  if (def.entry.orders.some((o) => isOptionLeg(o) && o.side === 'sell_short')) uses.add('combo');
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
