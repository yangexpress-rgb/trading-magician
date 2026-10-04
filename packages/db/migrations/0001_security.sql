-- Security boundaries for Phase 0 (Design v1.0 §4.1, §16.1, §16.2; proposal §5).
--
-- Roles (group roles, NOLOGIN; login users are granted membership out of band):
--   tm_app  : the web/worker application. Row-level security confines it to the
--             tenant named by the transaction-local setting app.user_id.
--   tm_auth : the authentication library. Sees auth tables only, never tenant data.
-- The migration owner is a separate role and is not used at runtime.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tm_app') THEN
    CREATE ROLE tm_app NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tm_auth') THEN
    CREATE ROLE tm_auth NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tm_app, tm_auth;
--> statement-breakpoint
-- The current tenant, or NULL when none is set (NULL matches no rows).
CREATE FUNCTION app_current_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_current_user_id() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_current_user_id() TO tm_app;
--> statement-breakpoint
CREATE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;
--> statement-breakpoint
CREATE TRIGGER user_set_updated_at BEFORE UPDATE ON "user"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER profile_set_updated_at BEFORE UPDATE ON "profile"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER entitlement_set_updated_at BEFORE UPDATE ON "entitlement"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER data_feed_connection_set_updated_at BEFORE UPDATE ON "data_feed_connection"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER data_route_set_updated_at BEFORE UPDATE ON "data_route"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER broker_connection_set_updated_at BEFORE UPDATE ON "broker_connection"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER trading_account_set_updated_at BEFORE UPDATE ON "trading_account"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER instrument_set_updated_at BEFORE UPDATE ON "instrument"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
-- Tenant-owned tables: every row is visible and writable only inside its own tenant.
--> statement-breakpoint
ALTER TABLE "profile" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "profile" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "profile" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "profile" TO tm_app;
--> statement-breakpoint
ALTER TABLE "entitlement" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "entitlement" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "entitlement" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
-- Entitlements are written by provisioning now and by billing webhooks in Phase 6;
-- the app may create its own row but never change limits.
GRANT SELECT, INSERT ON "entitlement" TO tm_app;
--> statement-breakpoint
ALTER TABLE "data_feed_connection" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "data_feed_connection" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "data_feed_connection" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "data_feed_connection" TO tm_app;
--> statement-breakpoint
ALTER TABLE "data_route" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "data_route" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "data_route" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "data_route" TO tm_app;
--> statement-breakpoint
ALTER TABLE "broker_connection" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "broker_connection" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "broker_connection" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "broker_connection" TO tm_app;
--> statement-breakpoint
ALTER TABLE "trading_account" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "trading_account" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "trading_account" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "trading_account" TO tm_app;
--> statement-breakpoint
-- user: owned by the auth library. The app may read only its own row.
ALTER TABLE "user" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "user" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY auth_all ON "user" TO tm_auth USING (true) WITH CHECK (true);
--> statement-breakpoint
CREATE POLICY self_read ON "user" FOR SELECT TO tm_app USING (id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "user" TO tm_auth;
--> statement-breakpoint
GRANT SELECT ON "user" TO tm_app;
--> statement-breakpoint
-- instrument: global reference data, read-only at runtime.
GRANT SELECT ON "instrument" TO tm_app;
--> statement-breakpoint
-- audit_event: append-only. Readable and insertable within the tenant; nobody,
-- including the owner, can update or delete rows.
ALTER TABLE "audit_event" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_event" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON "audit_event" FOR SELECT TO tm_app USING (user_id = app_current_user_id());
--> statement-breakpoint
CREATE POLICY tenant_append ON "audit_event" FOR INSERT TO tm_app WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_event" TO tm_app;
--> statement-breakpoint
CREATE FUNCTION reject_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN RAISE EXCEPTION 'audit_event is append-only' USING ERRCODE = 'insufficient_privilege'; END $$;
--> statement-breakpoint
CREATE TRIGGER audit_event_no_update_delete BEFORE UPDATE OR DELETE ON "audit_event"
  FOR EACH ROW EXECUTE FUNCTION reject_audit_mutation();
--> statement-breakpoint
CREATE TRIGGER audit_event_no_truncate BEFORE TRUNCATE ON "audit_event"
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_mutation();
