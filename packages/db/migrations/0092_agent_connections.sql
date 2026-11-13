CREATE TYPE "public"."agent_auth_method" AS ENUM('token', 'oauth');--> statement-breakpoint
CREATE TYPE "public"."agent_scope" AS ENUM('read', 'operate');--> statement-breakpoint
CREATE TABLE "agent_call_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"connection_id" uuid,
	"tool" text NOT NULL,
	"args" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"outcome" text NOT NULL,
	"error_class" text,
	"duration_ms" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_call_log_outcome" CHECK ("agent_call_log"."outcome" IN ('ok', 'error', 'refused')),
	CONSTRAINT "agent_call_log_tool" CHECK (char_length("agent_call_log"."tool") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "agent_connection" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"profile_id" text NOT NULL,
	"name" text NOT NULL,
	"auth_method" "agent_auth_method" NOT NULL,
	"scope" "agent_scope" DEFAULT 'read' NOT NULL,
	"oauth_client_id" uuid,
	"token_hint" text,
	"expires_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_connection_profile" CHECK ("agent_connection"."profile_id" ~ '^[a-z0-9-]{1,40}$'),
	CONSTRAINT "agent_connection_name" CHECK (char_length("agent_connection"."name") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE TABLE "agent_credential" (
	"hash" char(64) PRIMARY KEY NOT NULL,
	"connection_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_credential_kind" CHECK ("agent_credential"."kind" IN ('token', 'access', 'refresh'))
);
--> statement-breakpoint
CREATE TABLE "agent_oauth_client" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" text NOT NULL,
	"client_name" text NOT NULL,
	"redirect_uris" text[] NOT NULL,
	"secret_hash" char(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_oauth_client_client_id_unique" UNIQUE("client_id"),
	CONSTRAINT "agent_oauth_client_name" CHECK (char_length("agent_oauth_client"."client_name") BETWEEN 1 AND 200),
	CONSTRAINT "agent_oauth_client_redirects" CHECK (cardinality("agent_oauth_client"."redirect_uris") BETWEEN 1 AND 10)
);
--> statement-breakpoint
CREATE TABLE "agent_oauth_code" (
	"hash" char(64) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"redirect_uri" text NOT NULL,
	"code_challenge" text NOT NULL,
	"scope" "agent_scope" NOT NULL,
	"profile_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"connection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_oauth_code_profile" CHECK ("agent_oauth_code"."profile_id" ~ '^[a-z0-9-]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "agent_call_log" ADD CONSTRAINT "agent_call_log_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_call_log" ADD CONSTRAINT "agent_call_log_connection_id_agent_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connection" ADD CONSTRAINT "agent_connection_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_connection" ADD CONSTRAINT "agent_connection_oauth_client_id_agent_oauth_client_id_fk" FOREIGN KEY ("oauth_client_id") REFERENCES "public"."agent_oauth_client"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credential" ADD CONSTRAINT "agent_credential_connection_id_agent_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connection"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_credential" ADD CONSTRAINT "agent_credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_oauth_code" ADD CONSTRAINT "agent_oauth_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_oauth_code" ADD CONSTRAINT "agent_oauth_code_client_id_agent_oauth_client_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."agent_oauth_client"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_oauth_code" ADD CONSTRAINT "agent_oauth_code_connection_id_agent_connection_id_fk" FOREIGN KEY ("connection_id") REFERENCES "public"."agent_connection"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_call_log_user_idx" ON "agent_call_log" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_call_log_created_idx" ON "agent_call_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "agent_connection_user_idx" ON "agent_connection" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_credential_connection_idx" ON "agent_credential" USING btree ("connection_id");
--> statement-breakpoint
-- Agent connections (Bring your own AI agent brief, ADR 0092). Connections,
-- credentials, codes and the call log are tenant rows like every other; the
-- MCP endpoint and the OAuth token endpoint find a secret's owner through the
-- SECURITY DEFINER functions below, which take only SHA-256 hashes.
CREATE TRIGGER agent_connection_set_updated_at BEFORE UPDATE ON "agent_connection"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "agent_connection" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_connection" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "agent_connection" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "agent_connection" TO tm_app;
--> statement-breakpoint
GRANT UPDATE (name, revoked_at, last_used_at) ON "agent_connection" TO tm_app;
--> statement-breakpoint
ALTER TABLE "agent_credential" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_credential" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "agent_credential" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
-- The app mints token credentials; it never reads hashes back.
GRANT INSERT ON "agent_credential" TO tm_app;
--> statement-breakpoint
ALTER TABLE "agent_oauth_code" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_oauth_code" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "agent_oauth_code" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT INSERT ON "agent_oauth_code" TO tm_app;
--> statement-breakpoint
ALTER TABLE "agent_call_log" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "agent_call_log" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "agent_call_log" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "agent_call_log" TO tm_app;
--> statement-breakpoint
-- Dynamic client registration is open (RFC 7591); the endpoint is rate limited.
GRANT SELECT, INSERT ON "agent_oauth_client" TO tm_app;
--> statement-breakpoint
-- The functions below run as the migration owner, which row-level security
-- also binds where it is not a superuser (the tables force it).
DO $$
BEGIN
  EXECUTE format('CREATE POLICY definer_access ON "agent_connection" TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY definer_access ON "agent_credential" TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY definer_access ON "agent_oauth_code" TO %I USING (true) WITH CHECK (true)', current_user);
  EXECUTE format('CREATE POLICY definer_access ON "agent_call_log" TO %I USING (true) WITH CHECK (true)', current_user);
END
$$;
--> statement-breakpoint
-- Who a presented secret acts for. state: ok, revoked (the connection was
-- revoked), expired (the credential or the connection ran out) or closed (the
-- account was deleted or locked). Nothing for a hash that matches no secret.
CREATE FUNCTION agent_resolve_credential(p_hash char(64))
  RETURNS TABLE (connection_id uuid, user_id uuid, scope agent_scope, profile_id text,
                 kind text, state text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT c.id, c.user_id, c.scope, c.profile_id, k.kind,
           CASE
             WHEN u.deleted_at IS NOT NULL OR u.locked_at IS NOT NULL THEN 'closed'
             WHEN c.revoked_at IS NOT NULL THEN 'revoked'
             WHEN (k.expires_at IS NOT NULL AND k.expires_at <= now())
               OR (c.expires_at IS NOT NULL AND c.expires_at <= now()) THEN 'expired'
             ELSE 'ok'
           END
      FROM agent_credential AS k
      JOIN agent_connection AS c ON c.id = k.connection_id
      JOIN "user" AS u ON u.id = c.user_id
     WHERE k.hash = p_hash
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_resolve_credential(char) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_resolve_credential(char) TO tm_app;
--> statement-breakpoint
-- Exchanges an authorization code (RFC 6749 §4.1.3 with PKCE): checks it is
-- unused, unexpired and for this client, redirect URI and challenge; makes
-- the connection and stores the new access and refresh token hashes. A code
-- presented twice revokes the connection it made (RFC 6749 §4.1.2).
CREATE FUNCTION agent_oauth_redeem_code(
    p_code_hash char(64), p_client uuid, p_redirect_uri text, p_challenge text,
    p_access_hash char(64), p_access_expires timestamptz,
    p_refresh_hash char(64), p_refresh_expires timestamptz)
  RETURNS TABLE (connection_id uuid, scope agent_scope)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_code agent_oauth_code%ROWTYPE;
  v_name text;
  v_connection uuid;
BEGIN
  SELECT * INTO v_code FROM agent_oauth_code AS c WHERE c.hash = p_code_hash FOR UPDATE;
  IF NOT FOUND OR v_code.client_id <> p_client THEN
    RETURN;
  END IF;
  IF v_code.used_at IS NOT NULL THEN
    UPDATE agent_connection AS a SET revoked_at = coalesce(a.revoked_at, now())
     WHERE a.id = v_code.connection_id;
    RETURN;
  END IF;
  IF v_code.expires_at <= now() OR v_code.redirect_uri <> p_redirect_uri
     OR v_code.code_challenge <> p_challenge THEN
    RETURN;
  END IF;
  SELECT left(o.client_name, 80) INTO v_name FROM agent_oauth_client AS o WHERE o.id = p_client;
  INSERT INTO agent_connection (user_id, profile_id, name, auth_method, scope, oauth_client_id)
  VALUES (v_code.user_id, v_code.profile_id, coalesce(nullif(v_name, ''), 'OAuth agent'),
          'oauth', v_code.scope, p_client)
  RETURNING id INTO v_connection;
  INSERT INTO agent_credential (hash, connection_id, user_id, kind, expires_at) VALUES
    (p_access_hash, v_connection, v_code.user_id, 'access', p_access_expires),
    (p_refresh_hash, v_connection, v_code.user_id, 'refresh', p_refresh_expires);
  UPDATE agent_oauth_code AS c SET used_at = now(), connection_id = v_connection
   WHERE c.hash = p_code_hash;
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES (v_code.user_id, 'user', 'agent_connection.created', 'agent_connection', v_connection,
          jsonb_build_object('authMethod', 'oauth', 'profileId', v_code.profile_id,
                             'scope', v_code.scope));
  RETURN QUERY SELECT v_connection, v_code.scope;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_oauth_redeem_code(char, uuid, text, text, char, timestamptz, char, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_oauth_redeem_code(char, uuid, text, text, char, timestamptz, char, timestamptz) TO tm_app;
--> statement-breakpoint
-- Rotates a refresh token (OAuth 2.1 §4.3.1): the old one stops working, a new
-- access and refresh token take its place. Refused for a revoked or expired
-- connection, a closed account, or another client's token.
CREATE FUNCTION agent_oauth_refresh(
    p_refresh_hash char(64), p_client uuid,
    p_access_hash char(64), p_access_expires timestamptz,
    p_new_refresh_hash char(64), p_refresh_expires timestamptz)
  RETURNS TABLE (connection_id uuid, scope agent_scope)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_connection uuid;
  v_user uuid;
  v_scope agent_scope;
BEGIN
  SELECT c.id, c.user_id, c.scope INTO v_connection, v_user, v_scope
    FROM agent_credential AS k
    JOIN agent_connection AS c ON c.id = k.connection_id
    JOIN "user" AS u ON u.id = c.user_id
   WHERE k.hash = p_refresh_hash AND k.kind = 'refresh'
     AND (k.expires_at IS NULL OR k.expires_at > now())
     AND c.revoked_at IS NULL AND c.oauth_client_id = p_client
     AND u.deleted_at IS NULL AND u.locked_at IS NULL
   FOR UPDATE OF k;
  IF v_connection IS NULL THEN
    RETURN;
  END IF;
  DELETE FROM agent_credential AS k WHERE k.hash = p_refresh_hash;
  -- Access tokens past their time are of no further use.
  DELETE FROM agent_credential AS k
   WHERE k.connection_id = v_connection AND k.kind = 'access' AND k.expires_at <= now();
  INSERT INTO agent_credential (hash, connection_id, user_id, kind, expires_at) VALUES
    (p_access_hash, v_connection, v_user, 'access', p_access_expires),
    (p_new_refresh_hash, v_connection, v_user, 'refresh', p_refresh_expires);
  RETURN QUERY SELECT v_connection, v_scope;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_oauth_refresh(char, uuid, char, timestamptz, char, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_oauth_refresh(char, uuid, char, timestamptz, char, timestamptz) TO tm_app;
--> statement-breakpoint
-- Token revocation (RFC 7009): revokes the whole connection the token belongs
-- to, as Revoke in Settings does. Only the client the token was issued to may.
CREATE FUNCTION agent_oauth_revoke(p_hash char(64), p_client uuid)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_connection uuid;
  v_user uuid;
BEGIN
  SELECT c.id, c.user_id INTO v_connection, v_user
    FROM agent_credential AS k
    JOIN agent_connection AS c ON c.id = k.connection_id
   WHERE k.hash = p_hash AND c.oauth_client_id = p_client AND c.revoked_at IS NULL;
  IF v_connection IS NULL THEN
    RETURN false;
  END IF;
  UPDATE agent_connection AS c SET revoked_at = now() WHERE c.id = v_connection;
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES (v_user, 'system', 'agent_connection.revoked', 'agent_connection', v_connection,
          jsonb_build_object('by', 'oauth_revocation'));
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_oauth_revoke(char, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_oauth_revoke(char, uuid) TO tm_app;
--> statement-breakpoint
-- Retention (brief §5): call log rows go after 90 days, used or expired codes
-- after a day. Worker only.
CREATE FUNCTION agent_log_prune(p_days integer)
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH codes AS (
      DELETE FROM agent_oauth_code WHERE created_at < now() - interval '1 day' RETURNING 1
    ), gone AS (
      DELETE FROM agent_call_log
       WHERE created_at < now() - make_interval(days => greatest(p_days, 1))
      RETURNING 1)
    SELECT count(*)::integer FROM gone
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION agent_log_prune(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION agent_log_prune(integer) TO tm_secrets;
--> statement-breakpoint
-- The purge (0048, 0060, 0071) also removes the person's agent connections.
CREATE OR REPLACE FUNCTION purge_deleted_accounts(p_after_days integer, p_limit integer)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_user record;
  v_count integer := 0;
BEGIN
  IF p_after_days < 30 THEN
    RAISE EXCEPTION 'accounts are kept at least 30 days after deletion'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOR v_user IN
    SELECT id, email FROM "user"
     WHERE deleted_at IS NOT NULL
       AND purged_at IS NULL
       AND deleted_at <= now() - make_interval(days => p_after_days)
     ORDER BY deleted_at
     LIMIT greatest(p_limit, 1)
     FOR UPDATE SKIP LOCKED
  LOOP
    -- Sign-in material and anything that names the person.
    DELETE FROM "session" WHERE user_id = v_user.id;
    DELETE FROM "account" WHERE user_id = v_user.id;
    DELETE FROM "verification" WHERE value = v_user.id::text OR identifier = v_user.email;
    -- Provider keys: connections keep their rows (orders point at them) but lose the key.
    UPDATE data_feed_connection
       SET credential_ref = NULL, is_active = false, name = 'Deleted feed', last_error = NULL,
           -- A custom feed must keep a config (0053), so its settings become empty.
           config = CASE WHEN config IS NULL THEN NULL ELSE '{}'::jsonb END
     WHERE user_id = v_user.id;
    UPDATE broker_connection
       SET credential_ref = NULL, is_active = false, name = 'Deleted platform', last_error = NULL
     WHERE user_id = v_user.id;
    DELETE FROM credential WHERE user_id = v_user.id;
    UPDATE trading_account
       SET nickname = 'Deleted account', masked_external_id = '••••', external_id = NULL,
           is_active = false
     WHERE user_id = v_user.id;
    -- Strategies stay because orders and versions point at them; their own words go.
    UPDATE strategy
       SET name = 'Deleted strategy', description = '', tags = '{}'
     WHERE user_id = v_user.id;
    -- Not order records: back tests, notifications and research caches.
    DELETE FROM backtest_run WHERE user_id = v_user.id;
    DELETE FROM notification WHERE user_id = v_user.id;
    DELETE FROM instrument_lookup WHERE user_id = v_user.id;
    DELETE FROM price_chart WHERE user_id = v_user.id;
    DELETE FROM stock_screen WHERE user_id = v_user.id;
    DELETE FROM company_report WHERE user_id = v_user.id;
    -- Custom REST feeds (0053): saved tests, cached answers and request counts.
    DELETE FROM custom_feed_test WHERE user_id = v_user.id;
    DELETE FROM custom_feed_cache WHERE user_id = v_user.id;
    DELETE FROM custom_feed_usage WHERE user_id = v_user.id;
    -- AI agent connections (0092): credentials, codes, activity and the connections.
    DELETE FROM agent_credential WHERE user_id = v_user.id;
    DELETE FROM agent_oauth_code WHERE user_id = v_user.id;
    DELETE FROM agent_call_log WHERE user_id = v_user.id;
    DELETE FROM agent_connection WHERE user_id = v_user.id;
    -- Shares (0071): names go; what the person sent and nobody took goes too.
    UPDATE strategy_share SET sender_name = NULL WHERE sender_id = v_user.id;
    UPDATE strategy_share SET recipient_name = NULL WHERE recipient_id = v_user.id;
    UPDATE strategy_share SET snapshot = '{}'::jsonb, note = NULL
     WHERE sender_id = v_user.id AND status <> 'accepted';
    UPDATE profile SET display_name = 'Deleted account', notification_prefs = '{}'
     WHERE user_id = v_user.id;
    UPDATE "user"
       SET name = 'Deleted account',
           email = 'deleted-' || id::text || '@deleted.invalid',
           email_verified = false,
           image = NULL,
           purged_at = now()
     WHERE id = v_user.id;
    INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id)
      VALUES (v_user.id, 'system', 'account.purged', 'user', v_user.id);
    v_count := v_count + 1;
  END LOOP;
  RETURN v_count;
END
$$;
