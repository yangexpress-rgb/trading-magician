import { sql } from 'drizzle-orm';
import type { Database, Transaction } from './client';
import { serviceHeartbeats } from './schema';

type Db = Database | Transaction;

/**
 * Counts one request for `key` in a fixed window shared by every web instance
 * (ADR 0025). Returns seconds to wait when over `limit`, else 0.
 */
export async function rateLimitHit(
  db: Db,
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<number> {
  const rows = await db.execute<{ wait: number }>(
    sql`select rate_limit_hit(${key}, ${limit}::integer, ${windowSeconds}::integer) as wait`,
  );
  return Number(rows[0]?.wait ?? 0);
}

/** Drops windows older than a day. Worker only. */
export async function pruneRateLimits(db: Db): Promise<number> {
  const rows = await db.execute<{ n: number }>(sql`select rate_limit_prune(86400) as n`);
  return Number(rows[0]?.n ?? 0);
}

/** Marks `service` alive. Worker only. */
export async function recordHeartbeat(db: Db, service: string, instance: string): Promise<void> {
  await db.execute(sql`select record_heartbeat(${service}, ${instance})`);
}

export interface Heartbeat {
  service: string;
  beatAt: Date;
}

export async function listHeartbeats(db: Db): Promise<Heartbeat[]> {
  return db
    .select({ service: serviceHeartbeats.service, beatAt: serviceHeartbeats.beatAt })
    .from(serviceHeartbeats);
}
