CREATE TABLE "watch_list_group" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer NOT NULL,
	"collapsed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_list_group_name" CHECK (char_length("watch_list_group"."name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "watch_list_item" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"group_id" uuid NOT NULL,
	"symbol" text NOT NULL,
	"instrument_id" uuid,
	"display_name" text,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_list_item_symbol" CHECK ("watch_list_item"."symbol" ~ '^[A-Z][A-Z0-9.]{0,9}$')
);
--> statement-breakpoint
CREATE TABLE "watch_list_view" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"viewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "watch_quote" (
	"symbol" text PRIMARY KEY NOT NULL,
	"last" double precision NOT NULL,
	"prev_close" double precision,
	"price_at" timestamp with time zone NOT NULL,
	"daily" boolean DEFAULT false NOT NULL,
	"source" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "watch_quote_last" CHECK ("watch_quote"."last" > 0)
);
--> statement-breakpoint
ALTER TABLE "watch_list_group" ADD CONSTRAINT "watch_list_group_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_list_item" ADD CONSTRAINT "watch_list_item_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_list_item" ADD CONSTRAINT "watch_list_item_group_id_watch_list_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."watch_list_group"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_list_item" ADD CONSTRAINT "watch_list_item_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "watch_list_view" ADD CONSTRAINT "watch_list_view_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "watch_list_group_user_idx" ON "watch_list_group" USING btree ("user_id","position");--> statement-breakpoint
CREATE UNIQUE INDEX "watch_list_item_symbol_idx" ON "watch_list_item" USING btree ("group_id","symbol");--> statement-breakpoint
CREATE INDEX "watch_list_item_user_idx" ON "watch_list_item" USING btree ("user_id");--> statement-breakpoint
-- A person's watch list is theirs only (N292, ADR 0101).
ALTER TABLE "watch_list_group" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "watch_list_group" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "watch_list_group" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "watch_list_group" TO tm_app;--> statement-breakpoint
ALTER TABLE "watch_list_item" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "watch_list_item" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "watch_list_item" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "watch_list_item" TO tm_app;--> statement-breakpoint
ALTER TABLE "watch_list_view" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "watch_list_view" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "watch_list_view" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "watch_list_view" TO tm_app;--> statement-breakpoint
-- Watched prices are public market data kept once for every tenant: only the
-- worker login (tm_secrets) writes them; the app login reads them.
GRANT SELECT, INSERT, UPDATE, DELETE ON "watch_quote" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "watch_quote" TO tm_app;--> statement-breakpoint
-- The symbols on watch lists open in the last p_seconds, with whose they are,
-- so the worker can price them through each person's own or shared feed.
CREATE FUNCTION watch_list_demand(p_seconds integer)
  RETURNS TABLE (watcher uuid, symbol text)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_seconds NOT BETWEEN 1 AND 3600 THEN
    RAISE EXCEPTION 'invalid demand window' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY
  SELECT DISTINCT i.user_id, i.symbol
    FROM watch_list_item AS i
    JOIN watch_list_view AS v ON v.user_id = i.user_id
    JOIN "user" AS u ON u.id = i.user_id
   WHERE v.viewed_at > now() - make_interval(secs => p_seconds)
     AND u.deleted_at IS NULL;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION watch_list_demand(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION watch_list_demand(integer) TO tm_app;
--> statement-breakpoint
-- The purge (ADR 0039) also removes the watch list (N292).
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
    DELETE FROM screen_snapshot WHERE user_id = v_user.id;
    DELETE FROM ai_assistant WHERE user_id = v_user.id;
    -- Watch lists (0100): group names are the person's own words.
    DELETE FROM watch_list_item WHERE user_id = v_user.id;
    DELETE FROM watch_list_group WHERE user_id = v_user.id;
    DELETE FROM watch_list_view WHERE user_id = v_user.id;
    DELETE FROM agent_connection WHERE user_id = v_user.id;
    -- Pattern discovery (0093): scans, with their patterns and occurrences, are research.
    DELETE FROM pattern_scan WHERE user_id = v_user.id;
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
