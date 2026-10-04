-- Security for strategy tables (Design v1.0 §4.1, §6.2, §16.2; proposal §4.4, §5).
-- Same tenant model as 0001_security: tm_app sees only rows of app.user_id.

-- current_version_id points at a version of the same strategy and tenant. Declared
-- here because strategy and strategy_version reference each other.
ALTER TABLE "strategy" ADD CONSTRAINT "strategy_current_version_fk"
  FOREIGN KEY ("current_version_id", "user_id")
  REFERENCES "strategy_version" ("id", "user_id");
--> statement-breakpoint
CREATE TRIGGER strategy_set_updated_at BEFORE UPDATE ON "strategy"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "strategy" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "strategy" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "strategy" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
-- No DELETE: strategies are soft-deleted so versions stay linked to history.
GRANT SELECT, INSERT, UPDATE ON "strategy" TO tm_app;
--> statement-breakpoint
ALTER TABLE "strategy_instrument" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "strategy_instrument" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "strategy_instrument" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
-- A projection rebuilt on every save.
GRANT SELECT, INSERT, DELETE ON "strategy_instrument" TO tm_app;
--> statement-breakpoint
ALTER TABLE "strategy_status_change" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "strategy_status_change" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "strategy_status_change" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "strategy_status_change" TO tm_app;
--> statement-breakpoint
-- strategy_version: immutable. The app may read and append; no role may update a
-- version or delete one directly. Rows go only when their strategy's owner account
-- is deleted, through the foreign-key cascade (a nested trigger).
ALTER TABLE "strategy_version" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "strategy_version" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON "strategy_version" FOR SELECT TO tm_app
  USING (user_id = app_current_user_id());
--> statement-breakpoint
CREATE POLICY tenant_append ON "strategy_version" FOR INSERT TO tm_app
  WITH CHECK (user_id = app_current_user_id() AND created_by = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "strategy_version" TO tm_app;
--> statement-breakpoint
CREATE FUNCTION reject_strategy_version_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  -- pg_trigger_depth() > 1 means this delete comes from a foreign-key cascade.
  IF TG_OP = 'DELETE' AND pg_trigger_depth() > 1 THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'strategy_version rows are immutable' USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER strategy_version_immutable BEFORE UPDATE OR DELETE ON "strategy_version"
  FOR EACH ROW EXECUTE FUNCTION reject_strategy_version_mutation();
--> statement-breakpoint
CREATE TRIGGER strategy_version_no_truncate BEFORE TRUNCATE ON "strategy_version"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_strategy_version_mutation();
