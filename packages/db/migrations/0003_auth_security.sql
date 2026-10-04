-- Auth tables belong to tm_auth alone (ADR 0003). The app role cannot read
-- sessions, password hashes or verification tokens.
ALTER TABLE "session" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "session" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_all ON "session" TO tm_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "account" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "account" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_all ON "account" TO tm_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "verification" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "verification" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_all ON "verification" TO tm_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
ALTER TABLE "rate_limit" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "rate_limit" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_all ON "rate_limit" TO tm_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "session", "account", "verification", "rate_limit" TO tm_auth;
--> statement-breakpoint
CREATE TRIGGER session_set_updated_at BEFORE UPDATE ON "session"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER account_set_updated_at BEFORE UPDATE ON "account"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER verification_set_updated_at BEFORE UPDATE ON "verification"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
