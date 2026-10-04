-- Sealed credentials (ADR 0015). tm_app (web and worker) may write a credential
-- and read its metadata, but never the sealed columns. tm_secrets, held only by
-- the worker's login, may read them. Decryption also needs the private key,
-- which only the worker process has.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tm_secrets') THEN
    CREATE ROLE tm_secrets NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO tm_secrets;
--> statement-breakpoint
CREATE TRIGGER credential_set_updated_at BEFORE UPDATE ON "credential"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "credential" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "credential" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "credential" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT (id, user_id, provider, label, environment, hint, key_id, rotated_at, created_at, updated_at, row_version)
  ON "credential" TO tm_app;
--> statement-breakpoint
GRANT INSERT, DELETE ON "credential" TO tm_app;
--> statement-breakpoint
GRANT UPDATE (label, hint, key_id, wrapped_key, iv, ciphertext, auth_tag, rotated_at, row_version)
  ON "credential" TO tm_app;
--> statement-breakpoint
GRANT SELECT (wrapped_key, iv, ciphertext, auth_tag) ON "credential" TO tm_secrets;
