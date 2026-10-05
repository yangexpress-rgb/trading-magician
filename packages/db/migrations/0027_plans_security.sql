-- plan: global configuration (ADR 0022). The app reads it; only the owner changes it.
CREATE TRIGGER plan_set_updated_at BEFORE UPDATE ON "plan"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
GRANT SELECT ON "plan" TO tm_app;
