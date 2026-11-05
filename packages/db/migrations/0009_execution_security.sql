-- Security for paper-execution tables (Design v1.0 §8.2, §8.5, §16.2; ADR 0010).
-- Same tenant model as 0001_security: tm_app sees only rows of app.user_id.
-- No table here grants DELETE: rows go with their strategy or account through
-- foreign-key cascades.

-- Order intents, order events and fills are append-only records of what was
-- decided and what happened. No role may change or delete one directly; rows go
-- only through a foreign-key cascade (a nested trigger).
CREATE FUNCTION reject_append_only_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% rows are append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER strategy_runtime_set_updated_at BEFORE UPDATE ON "strategy_runtime"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER strategy_cycle_set_updated_at BEFORE UPDATE ON "strategy_cycle"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER scheduled_action_set_updated_at BEFORE UPDATE ON "scheduled_action"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER broker_order_set_updated_at BEFORE UPDATE ON "broker_order"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "strategy_runtime" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "strategy_runtime" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "strategy_runtime" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "strategy_runtime" TO tm_app;
--> statement-breakpoint
ALTER TABLE "strategy_cycle" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "strategy_cycle" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "strategy_cycle" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "strategy_cycle" TO tm_app;
--> statement-breakpoint
-- Trigger evaluations are evidence for the orders they create (§16.2).
ALTER TABLE "trigger_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trigger_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trigger_event" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "trigger_event" TO tm_app;
--> statement-breakpoint
ALTER TABLE "scheduled_action" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "scheduled_action" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "scheduled_action" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "scheduled_action" TO tm_app;
--> statement-breakpoint
ALTER TABLE "order_intent" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "order_intent" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_intent" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "order_intent" TO tm_app;
--> statement-breakpoint
CREATE TRIGGER order_intent_append_only BEFORE UPDATE OR DELETE ON "order_intent"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER order_intent_no_truncate BEFORE TRUNCATE ON "order_intent"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
-- The broker-side view of each intent: the only order table that changes.
ALTER TABLE "broker_order" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "broker_order" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "broker_order" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "broker_order" TO tm_app;
--> statement-breakpoint
ALTER TABLE "order_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "order_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "order_event" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "order_event" TO tm_app;
--> statement-breakpoint
CREATE TRIGGER order_event_append_only BEFORE UPDATE OR DELETE ON "order_event"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER order_event_no_truncate BEFORE TRUNCATE ON "order_event"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
ALTER TABLE "fill" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "fill" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "fill" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "fill" TO tm_app;
--> statement-breakpoint
CREATE TRIGGER fill_append_only BEFORE UPDATE OR DELETE ON "fill"
  FOR EACH ROW EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
CREATE TRIGGER fill_no_truncate BEFORE TRUNCATE ON "fill"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_append_only_mutation();
--> statement-breakpoint
ALTER TABLE "position_snapshot" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "position_snapshot" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "position_snapshot" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "position_snapshot" TO tm_app;
