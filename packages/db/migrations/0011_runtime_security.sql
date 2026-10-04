-- Security and scheduling for the paper runtime (Design v1.0 §8.1, §8.5, §12.4; ADR 0012).
-- Same tenant model as 0001_security: tm_app sees only rows of app.user_id.
CREATE TRIGGER execution_control_set_updated_at BEFORE UPDATE ON "execution_control"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "broker_sync" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "broker_sync" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "broker_sync" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "broker_sync" TO tm_app;
--> statement-breakpoint
ALTER TABLE "execution_control" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "execution_control" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "execution_control" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "execution_control" TO tm_app;
--> statement-breakpoint
ALTER TABLE "paper_order" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "paper_order" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "paper_order" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "paper_order" TO tm_app;
--> statement-breakpoint
ALTER TABLE "paper_update" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "paper_update" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "paper_update" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "paper_update" TO tm_app;
--> statement-breakpoint
CREATE TRIGGER paper_update_append_only BEFORE UPDATE OR DELETE ON "paper_update"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
ALTER TABLE "paper_position" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "paper_position" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "paper_position" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "paper_position" TO tm_app;
--> statement-breakpoint
-- The claim function below runs as the migration owner, which FORCE ROW LEVEL
-- SECURITY also confines. These policies let that role, and only that role, see
-- every tenant's runtimes and orders; tm_app cannot assume it.
DO $$
BEGIN
  EXECUTE format('CREATE POLICY queue_owner ON "strategy_runtime" TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY queue_owner ON "order_intent" TO %I USING (true)', current_user);
  EXECUTE format('CREATE POLICY queue_owner ON "broker_order" TO %I USING (true)', current_user);
END
$$;
--> statement-breakpoint
-- Leases runtimes that need a pass: running or paused ones, and stopped ones
-- that still have orders at the broker (their updates must still be read, §8.1).
-- Returns only identifiers; the worker then works inside each runtime's tenant.
CREATE FUNCTION claim_strategy_runtimes(p_worker text, p_lease_seconds integer, p_limit integer)
  RETURNS TABLE (claimed_id uuid, claimed_user uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_limit NOT BETWEEN 1 AND 100
     OR char_length(p_worker) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  UPDATE strategy_runtime AS r
     SET lease_owner = p_worker,
         lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE r.id IN (
           SELECT c.id FROM strategy_runtime AS c
            WHERE (c.lease_expires_at IS NULL OR c.lease_expires_at < now())
              AND (c.status <> 'stopped' OR EXISTS (
                     SELECT 1 FROM order_intent AS i
                       JOIN broker_order AS b ON b.intent_id = i.id
                      WHERE i.runtime_id = c.id
                        AND b.state IN ('ready', 'submitted', 'acknowledged', 'partially_filled')))
            ORDER BY c.lease_expires_at NULLS FIRST, c.started_at
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING r.id, r.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_strategy_runtimes(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_strategy_runtimes(text, integer, integer) TO tm_app;
