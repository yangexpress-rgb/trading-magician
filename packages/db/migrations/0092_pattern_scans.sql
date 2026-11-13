CREATE TABLE "pattern_occurrence" (
	"pattern_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"instrument_id" uuid NOT NULL,
	"as_of" date NOT NULL,
	"window" text NOT NULL,
	"hit" boolean NOT NULL,
	"max_runup" double precision NOT NULL,
	"max_drawdown" double precision NOT NULL,
	"forward_return" double precision NOT NULL,
	CONSTRAINT "pattern_occurrence_pattern_id_instrument_id_as_of_pk" PRIMARY KEY("pattern_id","instrument_id","as_of"),
	CONSTRAINT "pattern_occurrence_window" CHECK ("pattern_occurrence"."window" in ('discovery', 'holdout', 'fresh'))
);
--> statement-breakpoint
CREATE TABLE "pattern_scan" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"config" jsonb NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"candidates_tested" integer,
	"finalists" integer,
	"verified" integer,
	"effective" jsonb,
	"error" text,
	"code_version" text,
	"seconds" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "pattern_scan_status" CHECK ("pattern_scan"."status" in ('queued', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "pattern" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scan_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"rank" integer NOT NULL,
	"rule" jsonb NOT NULL,
	"stats" jsonb NOT NULL,
	"status" text NOT NULL,
	"decay_state" text,
	"decay_stats" jsonb,
	"last_scored" date,
	"promoted_theory_id" uuid,
	"promoted_status" text,
	"promoted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pattern_status" CHECK ("pattern"."status" in ('candidate', 'verified')),
	CONSTRAINT "pattern_decay_state" CHECK ("pattern"."decay_state" is null or "pattern"."decay_state" in ('holding', 'weakening', 'broken'))
);
--> statement-breakpoint
ALTER TABLE "pattern_occurrence" ADD CONSTRAINT "pattern_occurrence_pattern_id_pattern_id_fk" FOREIGN KEY ("pattern_id") REFERENCES "public"."pattern"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_occurrence" ADD CONSTRAINT "pattern_occurrence_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_occurrence" ADD CONSTRAINT "pattern_occurrence_instrument_id_instrument_id_fk" FOREIGN KEY ("instrument_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern_scan" ADD CONSTRAINT "pattern_scan_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern" ADD CONSTRAINT "pattern_scan_id_pattern_scan_id_fk" FOREIGN KEY ("scan_id") REFERENCES "public"."pattern_scan"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern" ADD CONSTRAINT "pattern_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pattern" ADD CONSTRAINT "pattern_promoted_theory_id_strategy_library_entries_id_fk" FOREIGN KEY ("promoted_theory_id") REFERENCES "public"."strategy_library_entries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "pattern_scan_user_idx" ON "pattern_scan" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "pattern_scan_idx" ON "pattern" USING btree ("scan_id","rank");--> statement-breakpoint
CREATE INDEX "pattern_user_idx" ON "pattern" USING btree ("user_id");--> statement-breakpoint
-- Pattern scans, patterns and occurrences are the owner's (pattern brief §6),
-- like strategies: the app login sees only rows of app.user_id. The batch
-- service and the worker log in with tm_secrets too and see every row, as the
-- miner runs every member's queued scans and the weekly decay re-scores every
-- Verified pattern.
ALTER TABLE "pattern_scan" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pattern_scan" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pattern_scan" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint
CREATE POLICY batch_service ON "pattern_scan" TO tm_secrets USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "pattern_scan" TO tm_app;--> statement-breakpoint
GRANT SELECT, UPDATE ON "pattern_scan" TO tm_secrets;--> statement-breakpoint
ALTER TABLE "pattern" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pattern" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pattern" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());--> statement-breakpoint
CREATE POLICY batch_service ON "pattern" TO tm_secrets USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, UPDATE ON "pattern" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "pattern" TO tm_secrets;--> statement-breakpoint
ALTER TABLE "pattern_occurrence" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pattern_occurrence" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY tenant_isolation ON "pattern_occurrence" TO tm_app
  USING (user_id = app_current_user_id());--> statement-breakpoint
CREATE POLICY batch_service ON "pattern_occurrence" TO tm_secrets USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT ON "pattern_occurrence" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT ON "pattern_occurrence" TO tm_secrets;--> statement-breakpoint
-- A pattern's rule, stats and occurrences are the scan's evidence: written
-- once. The app may only record a promotion; decay may only update its state.
CREATE FUNCTION pattern_guard() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.rule IS DISTINCT FROM OLD.rule OR NEW.stats IS DISTINCT FROM OLD.stats
     OR NEW.status IS DISTINCT FROM OLD.status OR NEW.scan_id IS DISTINCT FROM OLD.scan_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.rank IS DISTINCT FROM OLD.rank THEN
    RAISE EXCEPTION 'a pattern''s rule and evidence are never rewritten'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER pattern_guard BEFORE UPDATE ON "pattern"
  FOR EACH ROW EXECUTE FUNCTION pattern_guard();
--> statement-breakpoint
-- Account purge (design v1.1 D1): a purged account's scans and patterns go.
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
    -- Pattern discovery (0092): scans, with their patterns and occurrences, are research.
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
