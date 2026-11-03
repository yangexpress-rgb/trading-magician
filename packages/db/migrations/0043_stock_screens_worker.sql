-- Stock screens (ADR 0030): people ask for a screen in Quantitative Research,
-- the worker fills it in through the tenant's data feed.
CREATE TRIGGER stock_screen_set_updated_at BEFORE UPDATE ON "stock_screen"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "stock_screen" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "stock_screen" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "stock_screen" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "stock_screen" TO tm_app;
--> statement-breakpoint
GRANT UPDATE (status, session_date, rows, row_count, warnings, source, message, lease_expires_at, attempts) ON "stock_screen" TO tm_app;
--> statement-breakpoint
-- The worker claims pending screens across tenants, then fills each in its
-- tenant's scope. Claiming also clears screens older than an hour: they are a
-- large cache of provider data, not a record, and a fresh one is a click away.
CREATE FUNCTION claim_stock_screens(p_lease_seconds integer, p_limit integer)
  RETURNS TABLE (claimed_id uuid, claimed_user uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM stock_screen WHERE created_at < now() - interval '1 hour';

  RETURN QUERY
  UPDATE stock_screen AS s
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = s.attempts + 1
   WHERE s.id IN (
           SELECT p.id FROM stock_screen AS p
            WHERE p.status = 'pending'
              AND (p.lease_expires_at IS NULL OR p.lease_expires_at < now())
            ORDER BY p.created_at
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING s.id, s.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_stock_screens(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_stock_screens(integer, integer) TO tm_app;
