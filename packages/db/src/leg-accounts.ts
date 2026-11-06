import { and, eq } from 'drizzle-orm';
import type { Transaction } from './client';
import { brokerConnections, tradingAccounts } from './schema';

/** What choosing an account for a new leg needs to know about each account. */
export interface LegAccountCandidate {
  id: string;
  nickname: string;
  provider: string;
  mode: 'paper' | 'live';
  isDefault: boolean;
}

/**
 * The account a new leg starts on: a real broker's paper account (Alpaca
 * paper) when there is one, preferring the one marked default; only without
 * one the default account, which is the built-in paper account. Live
 * accounts are never chosen. Existing legs are never changed by this.
 */
export function pickLegAccount(accounts: readonly LegAccountCandidate[]): string | null {
  const paper = accounts.filter((a) => a.mode === 'paper');
  const real = paper.filter((a) => a.provider !== 'demo');
  const byName = (a: LegAccountCandidate, b: LegAccountCandidate) =>
    a.nickname.localeCompare(b.nickname);
  const pick =
    real.find((a) => a.isDefault) ??
    [...real].sort(byName)[0] ??
    paper.find((a) => a.isDefault) ??
    [...paper].sort(byName)[0];
  return pick?.id ?? null;
}

/** The tenant's active accounts, as `pickLegAccount` reads them. */
export async function legAccountCandidates(tx: Transaction): Promise<LegAccountCandidate[]> {
  return tx
    .select({
      id: tradingAccounts.id,
      nickname: tradingAccounts.nickname,
      provider: brokerConnections.provider,
      mode: tradingAccounts.mode,
      isDefault: tradingAccounts.isDefault,
    })
    .from(tradingAccounts)
    .innerJoin(
      brokerConnections,
      and(
        eq(brokerConnections.id, tradingAccounts.brokerConnectionId),
        eq(brokerConnections.isActive, true),
      ),
    )
    .where(eq(tradingAccounts.isActive, true));
}

export async function preferredLegAccountId(tx: Transaction): Promise<string | null> {
  return pickLegAccount(await legAccountCandidates(tx));
}
