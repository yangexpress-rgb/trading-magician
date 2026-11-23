CREATE TABLE "order_price_view" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "order_price_view" ADD CONSTRAINT "order_price_view_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- When a person last had Orders open is theirs only (N330).
ALTER TABLE "order_price_view" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "order_price_view" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_price_view" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "order_price_view" TO tm_app;--> statement-breakpoint
-- The symbols the worker prices (N292), now also the instruments of each
-- person's orders while they have Orders open (N330): orders of runs not yet
-- stopped, and any order from the last 7 days. Orders refreshes about every
-- 30 seconds, so its window is at least 90 seconds.
CREATE OR REPLACE FUNCTION watch_list_demand(p_seconds integer)
  RETURNS TABLE (watcher uuid, symbol text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid demand window' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT i.user_id, i.symbol
    FROM watch_list_item AS i
    JOIN watch_list_view AS v ON v.user_id = i.user_id
    JOIN "user" AS u ON u.id = i.user_id
   WHERE v.viewed_at > now() - make_interval(secs => p_seconds)
     AND u.deleted_at IS NULL
  UNION
  SELECT o.user_id, ins.symbol
    FROM order_intent AS o
    JOIN order_price_view AS ov ON ov.user_id = o.user_id
    JOIN "user" AS u ON u.id = o.user_id
    JOIN instrument AS ins ON ins.id = o.instrument_id
    JOIN strategy_runtime AS r ON r.id = o.runtime_id
   WHERE ov.viewed_at > now() - make_interval(secs => greatest(p_seconds, 90))
     AND u.deleted_at IS NULL
     AND ins.asset_class IN ('stock', 'etf')
     AND (r.status <> 'stopped' OR o.created_at > now() - interval '7 days');
END
$$;
