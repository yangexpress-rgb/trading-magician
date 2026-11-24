import { sql } from 'drizzle-orm';
import type { Database } from './client';
import type { ResearchStore } from './research';

/**
 * Storage upkeep (ADR 0115): retention trims, the Research Store's integrity
 * sweep and database sizes for the 80% alert. Worker only: every function
 * here goes through a definer function the worker's batch role may call.
 */

const count = (rows: Iterable<Record<string, unknown>>) => Number([...rows][0]?.n ?? 0);

/** Deletes notifications older than `days`. */
export async function expireNotifications(core: Database, days: number): Promise<number> {
  return count(await core.execute(sql`select expire_notifications(${days}::integer) as n`));
}

/** Deletes audit events older than `days` (at least 365). */
export async function expireAuditEvents(core: Database, days: number): Promise<number> {
  return count(await core.execute(sql`select expire_audit_events(${days}::integer) as n`));
}

/** Keeps one position snapshot a day once older than `days`. */
export async function thinPositionSnapshots(core: Database, days: number): Promise<number> {
  return count(await core.execute(sql`select thin_position_snapshots(${days}::integer) as n`));
}

const ids = (rows: Iterable<Record<string, unknown>>, key: string) =>
  [...rows].map((r) => String(r[key]));

const uuidArray = (list: readonly string[]) => sql`${`{${list.join(',')}}`}::uuid[]`;

export interface SweepResult {
  /** Research rows of accounts Core has purged. */
  purgedUserRows: number;
  /** Back test trades whose run is gone from Core. */
  orphanTrades: number;
}

/**
 * Removes Research Store rows whose owner or back test run is gone from Core
 * (the cascades a single database used to do; ADR 0115 §Integrity).
 */
export async function sweepResearchStore(
  core: Database,
  research: ResearchStore,
): Promise<SweepResult> {
  const out: SweepResult = { purgedUserRows: 0, orphanTrades: 0 };
  const users = ids(await research.db.execute(sql`select research_user_ids() as id`), 'id');
  if (users.length > 0) {
    const present = new Set(
      ids(await core.execute(sql`select core_users_present(${uuidArray(users)}) as id`), 'id'),
    );
    const gone = users.filter((u) => !present.has(u));
    if (gone.length > 0)
      out.purgedUserRows = count(
        await research.db.execute(sql`select purge_research_users(${uuidArray(gone)}) as n`),
      );
  }
  const runs = ids(await research.db.execute(sql`select research_trade_run_ids() as id`), 'id');
  for (let i = 0; i < runs.length; i += 5000) {
    const chunk = runs.slice(i, i + 5000);
    const present = new Set(
      ids(
        await core.execute(sql`select core_backtest_runs_present(${uuidArray(chunk)}) as id`),
        'id',
      ),
    );
    const gone = chunk.filter((r) => !present.has(r));
    if (gone.length > 0)
      out.orphanTrades += count(
        await research.db.execute(sql`select delete_research_trades(${uuidArray(gone)}) as n`),
      );
  }
  return out;
}

/** The database's size in bytes. */
export async function storageBytes(db: Database): Promise<number> {
  return count(await db.execute(sql`select storage_bytes() as n`));
}

/** Research tables that still hold rows in Core (the Window Contract's boundary check). */
export async function researchTablesInCore(core: Database): Promise<string[]> {
  return ids(await core.execute(sql`select research_tables_in_core() as t`), 't');
}
