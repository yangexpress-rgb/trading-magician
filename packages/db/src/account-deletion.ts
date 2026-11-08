import { and, eq, isNull, sql } from 'drizzle-orm';
import { recordAudit } from './audit';
import type { Database, Transaction } from './client';
import { unlinkAccountStrategies } from './library-lab';
import { closeSharesForAccount } from './sharing';
import { strategies } from './schema';
import { stopStrategy } from './strategies';

/**
 * Account deletion and retention (§4.2, §20 #14; design v1.1 C6, deviation D1).
 *
 * Deleting an account is two steps. At once: running strategies stop and their
 * working orders are canceled, the account is marked deleted and every session
 * ends, and sign-in is refused. After ACCOUNT_PURGE_DAYS the worker purges it:
 * personal details, keys, back tests, notifications and research caches go;
 * order and audit records stay, with names replaced (migration 0048).
 */
export const ACCOUNT_PURGE_DAYS = 30;

/**
 * The tenant's part of a deletion, inside its own transaction: stops what is
 * running and records the request. The auth side (marking the user, ending
 * sessions) is done by the web app's auth connection.
 */
export async function prepareAccountDeletion(
  tx: Transaction,
  userId: string,
): Promise<{ stoppedStrategies: number }> {
  const running = await tx
    .select({ id: strategies.id, rowVersion: strategies.rowVersion })
    .from(strategies)
    .where(and(eq(strategies.status, 'actively_executing'), isNull(strategies.deletedAt)));
  for (const s of running) {
    await stopStrategy(tx, userId, s.id, {
      rowVersion: s.rowVersion,
      reason: 'The account was deleted',
      cancelOpenOrders: true,
    });
  }
  // Library records its strategies built go back to Not built (ADR 0054).
  await unlinkAccountStrategies(tx, userId);
  // Shares it sent are withdrawn and shares waiting for it declined (ADR 0056).
  await closeSharesForAccount(tx);
  await recordAudit(tx, {
    userId,
    actorType: 'user',
    action: 'account.deleted',
    resourceType: 'user',
    resourceId: userId,
    context: { purgeAfterDays: ACCOUNT_PURGE_DAYS, stoppedStrategies: running.length },
  });
  return { stoppedStrategies: running.length };
}

/** Purges accounts deleted at least ACCOUNT_PURGE_DAYS ago. Worker only. */
export async function purgeDeletedAccounts(
  db: Database | Transaction,
  options: { limit?: number } = {},
): Promise<number> {
  const rows = await db.execute<{ n: number }>(
    sql`select purge_deleted_accounts(${ACCOUNT_PURGE_DAYS}::integer, ${options.limit ?? 20}::integer) as n`,
  );
  return Number(rows[0]?.n ?? 0);
}
