-- Tenant isolation and live updates for incidents and notifications (ADR 0014).
CREATE TRIGGER execution_incident_set_updated_at BEFORE UPDATE ON "execution_incident"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "execution_incident" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "execution_incident" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "execution_incident" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
-- Incidents are resolved, never deleted.
GRANT SELECT, INSERT, UPDATE ON "execution_incident" TO tm_app;
--> statement-breakpoint
ALTER TABLE "notification" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "notification" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "notification" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
-- Only read_at changes after insert.
GRANT SELECT, INSERT ON "notification" TO tm_app;
--> statement-breakpoint
GRANT UPDATE (read_at) ON "notification" TO tm_app;
--> statement-breakpoint
CREATE TRIGGER execution_incident_notify
  AFTER INSERT OR UPDATE ON execution_incident
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
--> statement-breakpoint
CREATE TRIGGER notification_notify
  AFTER INSERT OR UPDATE ON notification
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
