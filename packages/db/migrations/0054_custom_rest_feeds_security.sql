-- Custom REST feeds (ADR 0041): tests before saving, the response cache and
-- the request counters are tenant-isolated like every other table.
CREATE TRIGGER custom_feed_test_set_updated_at BEFORE UPDATE ON "custom_feed_test"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "custom_feed_test" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_feed_test" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "custom_feed_test" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "custom_feed_test" TO tm_app;
--> statement-breakpoint
GRANT UPDATE (status, result, message, lease_expires_at, attempts) ON "custom_feed_test" TO tm_app;
--> statement-breakpoint
ALTER TABLE "custom_feed_cache" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_feed_cache" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "custom_feed_cache" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "custom_feed_cache" TO tm_app;
--> statement-breakpoint
ALTER TABLE "custom_feed_usage" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "custom_feed_usage" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "custom_feed_usage" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "custom_feed_usage" TO tm_app;
--> statement-breakpoint
-- The worker claims pending tests across tenants, then runs each in its
-- tenant's scope. Claiming also clears tests older than a day.
CREATE FUNCTION claim_custom_feed_tests(p_lease_seconds integer, p_limit integer)
  RETURNS TABLE (claimed_id uuid, claimed_user uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM custom_feed_test WHERE created_at < now() - interval '1 day';

  RETURN QUERY
  UPDATE custom_feed_test AS t
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = t.attempts + 1
   WHERE t.id IN (
           SELECT p.id FROM custom_feed_test AS p
            WHERE p.status = 'pending'
              AND (p.lease_expires_at IS NULL OR p.lease_expires_at < now())
            ORDER BY p.created_at
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING t.id, t.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_custom_feed_tests(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_custom_feed_tests(integer, integer) TO tm_app;
--> statement-breakpoint
-- A finished test refreshes the open Settings page, like a feed check does.
CREATE TRIGGER custom_feed_test_notify
  AFTER UPDATE OF status ON custom_feed_test
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
