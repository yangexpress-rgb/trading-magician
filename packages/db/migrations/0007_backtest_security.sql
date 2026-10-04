-- Security and queue for back-test tables (Design v1.0 §7.2, §16.2; ADR 0009).
-- Same tenant model as 0001_security: tm_app sees only rows of app.user_id.
CREATE TRIGGER backtest_run_set_updated_at BEFORE UPDATE ON "backtest_run"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "backtest_run" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "backtest_run" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "backtest_run" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
-- No DELETE: runs go with their strategy or account through foreign-key cascades.
GRANT SELECT, INSERT, UPDATE ON "backtest_run" TO tm_app;
--> statement-breakpoint
ALTER TABLE "backtest_trade" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "backtest_trade" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "backtest_trade" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "backtest_trade" TO tm_app;
--> statement-breakpoint
-- The queue functions below run as the migration owner, which FORCE ROW LEVEL
-- SECURITY also confines. This policy lets that role, and only that role, see
-- every run; tm_app cannot assume it.
DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY queue_owner ON "backtest_run" TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END
$$;
--> statement-breakpoint
-- Claims the oldest runnable run for a worker: a queued run, or a running one
-- whose worker stopped renewing its lease. Expired runs that are out of attempts
-- fail, and expired runs whose cancel was requested end as canceled. Returns
-- only identifiers; the worker then reads and writes the run inside its tenant.
CREATE FUNCTION claim_backtest_run(p_worker text, p_lease_seconds integer, p_max_attempts integer)
  RETURNS TABLE (claimed_id uuid, claimed_user uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_max_attempts NOT BETWEEN 1 AND 10
     OR char_length(p_worker) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE backtest_run AS r
     SET status = CASE WHEN r.cancel_requested THEN 'canceled'::backtest_run_status
                       ELSE 'failed'::backtest_run_status END,
         error = CASE WHEN r.cancel_requested THEN NULL
                      ELSE 'The back test stopped responding and was abandoned' END,
         finished_at = now(),
         lease_owner = NULL,
         lease_expires_at = NULL
   WHERE r.status = 'running'
     AND r.lease_expires_at < now()
     AND (r.cancel_requested OR r.attempts >= p_max_attempts);

  RETURN QUERY
  UPDATE backtest_run AS r
     SET status = 'running',
         lease_owner = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = r.attempts + 1,
         started_at = coalesce(r.started_at, now())
   WHERE r.id = (
           SELECT c.id FROM backtest_run AS c
            WHERE (c.status = 'queued' OR (c.status = 'running' AND c.lease_expires_at < now()))
              AND NOT c.cancel_requested
            ORDER BY c.created_at
            FOR UPDATE SKIP LOCKED
            LIMIT 1)
  RETURNING r.id, r.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_backtest_run(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_backtest_run(text, integer, integer) TO tm_app;
