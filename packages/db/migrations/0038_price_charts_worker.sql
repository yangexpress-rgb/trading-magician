-- Price charts (ADR 0029): people ask for an instrument's bars in Quantitative
-- Research, the worker answers through the tenant's bars route.
CREATE TRIGGER price_chart_set_updated_at BEFORE UPDATE ON "price_chart"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "price_chart" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "price_chart" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "price_chart" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "price_chart" TO tm_app;
--> statement-breakpoint
GRANT UPDATE (status, bars, warnings, source, message, lease_expires_at, attempts) ON "price_chart" TO tm_app;
--> statement-breakpoint
-- The worker claims pending charts across tenants, then answers each in its
-- tenant's scope. Claiming also clears charts older than a day: they are a
-- cache of provider data, not a record.
CREATE FUNCTION claim_price_charts(p_lease_seconds integer, p_limit integer)
  RETURNS TABLE (claimed_id uuid, claimed_user uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM price_chart WHERE created_at < now() - interval '1 day';

  RETURN QUERY
  UPDATE price_chart AS c
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = c.attempts + 1
   WHERE c.id IN (
           SELECT p.id FROM price_chart AS p
            WHERE p.status = 'pending'
              AND (p.lease_expires_at IS NULL OR p.lease_expires_at < now())
            ORDER BY p.created_at
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING c.id, c.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_price_charts(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_price_charts(integer, integer) TO tm_app;
