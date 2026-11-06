-- Demo data is off in real deployments (ADR 0039): no invented DEMO-* instruments
-- and no demo feed. This removes them from existing databases. It never removes a
-- person's own records: anyone with a strategy, order or position on a demo
-- instrument keeps their demo feed and those instruments, so nothing they made
-- breaks. Only caches (charts, look-ups, screens) and unused demo rows go.
CREATE TEMP TABLE "demo_instrument" ON COMMIT DROP AS
  SELECT "id" FROM "instrument" WHERE "is_demo" OR "venue" = 'DEMO';--> statement-breakpoint
CREATE TEMP TABLE "demo_keeper" ON COMMIT DROP AS
  SELECT "user_id" FROM "strategy_instrument" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
  UNION SELECT "user_id" FROM "order_intent" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
  UNION SELECT "user_id" FROM "paper_position" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
  UNION SELECT "user_id" FROM "position_snapshot" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
  UNION SELECT "user_id" FROM "book_valuation" WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument");--> statement-breakpoint
-- Cached charts, look-ups and screens of the demo instruments.
DELETE FROM "price_chart"
  WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
    AND "user_id" NOT IN (SELECT "user_id" FROM "demo_keeper");--> statement-breakpoint
DELETE FROM "instrument_lookup"
  WHERE "instrument_id" IN (SELECT "id" FROM "demo_instrument")
    AND "user_id" NOT IN (SELECT "user_id" FROM "demo_keeper");--> statement-breakpoint
DELETE FROM "stock_screen"
  WHERE ("source" = 'Demo data' OR "rows"::text LIKE '%"DEMO-%')
    AND "user_id" NOT IN (SELECT "user_id" FROM "demo_keeper");--> statement-breakpoint
-- Demo routes and demo feeds, unless a strategy is still pinned to the route.
DELETE FROM "data_route" r
  WHERE r."user_id" NOT IN (SELECT "user_id" FROM "demo_keeper")
    AND (r."venue" = 'DEMO'
      OR r."primary_feed_id" IN (SELECT "id" FROM "data_feed_connection" WHERE "provider" = 'demo'))
    AND NOT EXISTS (SELECT 1 FROM "strategy" s WHERE s."data_route_id" = r."id");--> statement-breakpoint
UPDATE "data_route" SET "fallback_feed_id" = NULL
  WHERE "user_id" NOT IN (SELECT "user_id" FROM "demo_keeper")
    AND "fallback_feed_id" IN (SELECT "id" FROM "data_feed_connection" WHERE "provider" = 'demo');--> statement-breakpoint
DELETE FROM "data_feed_connection" f
  WHERE f."provider" = 'demo'
    AND f."user_id" NOT IN (SELECT "user_id" FROM "demo_keeper")
    AND NOT EXISTS (SELECT 1 FROM "data_route" r WHERE r."primary_feed_id" = f."id" OR r."fallback_feed_id" = f."id");--> statement-breakpoint
-- The demo instruments nobody's records use any more.
DELETE FROM "instrument" i
  WHERE i."id" IN (SELECT "id" FROM "demo_instrument")
    AND NOT EXISTS (SELECT 1 FROM "strategy_instrument" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "order_intent" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "position_snapshot" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "book_valuation" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "paper_position" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "price_chart" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "instrument_lookup" x WHERE x."instrument_id" = i."id")
    AND NOT EXISTS (SELECT 1 FROM "instrument" x WHERE x."underlying_id" = i."id");--> statement-breakpoint
-- The built-in paper account now trades real US listings, priced by the person's own feed.
UPDATE "trading_account" a
  SET "capabilities" = jsonb_set(a."capabilities", '{coverage}', '"us"'),
      "nickname" = CASE WHEN a."nickname" = 'Demo paper account' THEN 'Paper account' ELSE a."nickname" END
  FROM "broker_connection" b
  WHERE b."id" = a."broker_connection_id" AND b."provider" = 'demo'
    AND a."user_id" NOT IN (SELECT "user_id" FROM "demo_keeper")
    AND a."capabilities" ->> 'coverage' = 'demo';--> statement-breakpoint
UPDATE "broker_connection" SET "name" = 'Built-in paper broker'
  WHERE "provider" = 'demo' AND "name" = 'Demo paper broker'
    AND "user_id" NOT IN (SELECT "user_id" FROM "demo_keeper");--> statement-breakpoint
-- With no demo feed, the Free plan brings its own market data (Alpaca paper key).
UPDATE "plan"
  SET "limits" = jsonb_set("limits", '{liveData}', 'true'),
      "description" = CASE WHEN "description" = 'Paper trading on the demo account.'
        THEN 'Paper trading on the built-in paper account, with your own Alpaca market data.'
        ELSE "description" END
  WHERE "code" = 'free';
