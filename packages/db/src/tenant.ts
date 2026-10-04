import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The authenticated tenant. Built from the server-side session, never from client input. */
export interface TenantContext {
  readonly userId: string;
}

/**
 * Runs `fn` in a transaction scoped to one tenant. Row-level security policies
 * read `app.user_id`, which `set_config(..., true)` keeps local to this
 * transaction so it cannot leak to the next pooled use of the connection.
 */
export async function withTenant<T>(
  db: Database,
  tenant: TenantContext,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  if (!UUID.test(tenant.userId)) throw new TypeError('Tenant user id must be a UUID');
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${tenant.userId}, true)`);
    return fn(tx);
  });
}
