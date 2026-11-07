import { sql } from 'drizzle-orm';
import type { Database } from './client';
import { demoDataEnabled } from './demo';

/**
 * Design v1.2 item 10: the demo instruments are removed from real databases
 * (migration 0051, ADR 0039). Removal is blocked while someone's records still
 * use one, because orders, fills and positions keep their history. This lists
 * what is left and who uses it, so each can be cleared by hand with the owner's
 * say-so. Read-only; needs the owner connection (bypasses row-level security).
 */
export interface DemoReference {
  symbol: string;
  email: string | null;
  strategies: string[];
  orders: number;
  positions: number;
}

export async function listDemoReferences(db: Database): Promise<{
  instruments: number;
  feeds: number;
  references: DemoReference[];
}> {
  const [counts] = await db.execute<{ instruments: number; feeds: number }>(sql`
    select
      (select count(*)::int from instrument where is_demo or venue = 'DEMO') as instruments,
      (select count(*)::int from data_feed_connection where provider = 'demo') as feeds`);
  const rows = await db.execute<{
    symbol: string;
    email: string | null;
    strategies: string[] | null;
    orders: number;
    positions: number;
  }>(sql`
    with demo as (select id, symbol from instrument where is_demo or venue = 'DEMO'),
    users as (
      select instrument_id, user_id from strategy_instrument where instrument_id in (select id from demo)
      union select instrument_id, user_id from order_intent where instrument_id in (select id from demo)
      union select instrument_id, user_id from paper_position where instrument_id in (select id from demo)
      union select instrument_id, user_id from position_snapshot where instrument_id in (select id from demo)
    )
    select d.symbol, u.email,
      (select array_agg(distinct s.name order by s.name) from strategy_instrument x
         join strategy s on s.id = x.strategy_id
        where x.instrument_id = d.id and x.user_id = r.user_id) as strategies,
      (select count(*)::int from order_intent o
        where o.instrument_id = d.id and o.user_id = r.user_id) as orders,
      (select count(*)::int from paper_position p
        where p.instrument_id = d.id and p.user_id = r.user_id) as positions
    from users r
    join demo d on d.id = r.instrument_id
    left join "user" u on u.id = r.user_id
    order by d.symbol, u.email`);
  return {
    instruments: counts?.instruments ?? 0,
    feeds: counts?.feeds ?? 0,
    references: [...rows].map((r) => ({ ...r, strategies: r.strategies ?? [] })),
  };
}

/**
 * Removes the demo instruments and demo feeds nobody's records use any more,
 * as migration 0051 did once: for a database where 0051 had to keep some that
 * have since been cleared by hand. Refused while demo data is on (tests).
 */
export async function removeUnusedDemoData(db: Database): Promise<number> {
  if (demoDataEnabled()) throw new Error('Demo data is on here (DEMO_DATA=on); nothing removed');
  const before = await listDemoReferences(db);
  await db.transaction(async (tx) => {
    for (const statement of UNUSED_DEMO_CLEANUP) await tx.execute(sql.raw(statement));
  });
  const after = await listDemoReferences(db);
  return before.instruments - after.instruments;
}

/** The clean-up statements of migration 0051, kept in step with it. */
const UNUSED_DEMO_CLEANUP = [
  `CREATE TEMP TABLE "demo_instrument" ON COMMIT DROP AS
  SELECT "id" FROM "instrument" WHERE "is_demo" OR "venue" = 'DEMO';`,
  `CREATE TEMP TABLE "demo_keeper" ON COMMIT DROP AS
  SELECT "user_id" FROM "strategy_instrument" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
  UNION SELECT "user_id" FROM "order_intent" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
  UNION SELECT "user_id" FROM "paper_position" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
  UNION SELECT "user_id" FROM "position_snapshot" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
  UNION SELECT "user_id" FROM "book_valuation" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument");`,
  `DELETE FROM "price_chart"
  WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
    AND "user_id" NOT IN (SELECT "user_id" FROM "demo_keeper");`,
  `DELETE FROM "instrument_lookup"
  WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
    AND "user_id" NOT IN (SELECT "user_id" FROM "demo_keeper");`,
  `DELETE FROM "stock_screen"
  WHERE ("source" = 'Demo data' OR "rows"::text LIKE '%"DEMO-%')
    AND "user_id" NOT IN (SELECT "user_id" FROM "demo_keeper");`,
  `DELETE FROM "data_route" r
  WHERE r."user_id" NOT IN (SELECT "user_id" FROM "demo_keeper")
    AND (r."venue" = 'DEMO'
      OR r."primary_feed_id" IN (SELECT "id" FROM "data_feed_connection" WHERE "provider" = 'demo'))
    AND NOT EXISTS (SELECT 1 FROM "strategy" s WHERE s."data_route_id" = r."id");`,
  `UPDATE "data_route" SET "fallback_feed_id" = NULL
  WHERE "user_id" NOT IN (SELECT "user_id" FROM "demo_keeper")
    AND "fallback_feed_id" IN (SELECT "id" FROM "data_feed_connection" WHERE "provider" = 'demo');`,
  `DELETE FROM "data_feed_connection" f
  WHERE f."provider" = 'demo'
    AND f."user_id" NOT IN (SELECT "user_id" FROM "demo_keeper")
    AND NOT EXISTS (SELECT 1 FROM "data_route" r WHERE r."primary_feed_id" = f."id" OR r."fallback_feed_id" = f."id");`,
  `DELETE FROM "instrument" i
  WHERE i."id" IN (SELECT "id" FROM "demo_instrument")
    AND NOT EXISTS (SELECT 1 FROM "strategy_instrument" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "order_intent" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "position_snapshot" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "book_valuation" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "paper_position" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "price_chart" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "instrument_lookup" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "instrument" x WHERE x."underlying_id" = i."id");`,
];
