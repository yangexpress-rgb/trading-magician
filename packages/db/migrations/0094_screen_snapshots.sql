CREATE TABLE "screen_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"code" text NOT NULL,
	"question" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "screen_snapshot_code" CHECK ("screen_snapshot"."code" ~ '^[A-Z0-9]{8}$'),
	CONSTRAINT "screen_snapshot_question" CHECK (char_length("screen_snapshot"."question") <= 4000)
);
--> statement-breakpoint
ALTER TABLE "screen_snapshot" ADD CONSTRAINT "screen_snapshot_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "screen_snapshot_code_idx" ON "screen_snapshot" USING btree ("user_id","code");--> statement-breakpoint
CREATE INDEX "screen_snapshot_user_idx" ON "screen_snapshot" USING btree ("user_id","created_at");--> statement-breakpoint
-- Screen snapshots are the owner's (N272, ADR 0093): the app login sees only
-- rows of app.user_id, through the screens and through agent tools alike.
-- Nobody updates a snapshot; expired rows are deleted by their owner's next
-- save.
ALTER TABLE "screen_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "screen_snapshot" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "screen_snapshot" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON "screen_snapshot" TO tm_app;
--> statement-breakpoint
-- The purge (ADR 0039) also removes screen snapshots (N272).
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
