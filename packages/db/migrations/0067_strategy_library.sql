CREATE TABLE "convention_versions" (
	"label" text PRIMARY KEY NOT NULL,
	"effective_from" date NOT NULL,
	"tables" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "convention_versions_label" CHECK ("convention_versions"."label" ~ '^v[1-9][0-9]*$')
);
--> statement-breakpoint
CREATE TABLE "strategy_library_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_number" text NOT NULL,
	"sequence_no" integer NOT NULL,
	"convention_version" text NOT NULL,
	"record_type_code" char(1) NOT NULL,
	"timeframe_code" char(1) NOT NULL,
	"asset_class_code" char(1) NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"status" text DEFAULT 'registered' NOT NULL,
	"short_description" text NOT NULL,
	"long_description" text NOT NULL,
	"assets" text NOT NULL,
	"data_requirements" text,
	"entry" text NOT NULL,
	"exit" text NOT NULL,
	"frequency" jsonb NOT NULL,
	"turnaround" jsonb NOT NULL,
	"used_by" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"track_record" text,
	"backtest_summary" text,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"related_entries" text[] DEFAULT '{}'::text[] NOT NULL,
	"built_strategy_id" uuid,
	"built_strategy_owner" uuid,
	"retired_reason" text,
	"retired_at" timestamp with time zone,
	"retired_by" uuid,
	"seed_key" text,
	"registered_by" uuid,
	"registered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "strategy_library_entries_status" CHECK ("strategy_library_entries"."status" in ('registered', 'retired')),
	CONSTRAINT "strategy_library_entries_retired" CHECK (("strategy_library_entries"."status" = 'retired') = ("strategy_library_entries"."retired_at" is not null and "strategy_library_entries"."retired_reason" is not null)),
	CONSTRAINT "strategy_library_entries_number_shape" CHECK ("strategy_library_entries"."registration_number" = "strategy_library_entries"."record_type_code" || "strategy_library_entries"."timeframe_code" || "strategy_library_entries"."asset_class_code" || '-' || lpad("strategy_library_entries"."sequence_no"::text, greatest(4, length("strategy_library_entries"."sequence_no"::text)), '0')),
	CONSTRAINT "strategy_library_entries_name_length" CHECK (char_length("strategy_library_entries"."name") between 1 and 120),
	CONSTRAINT "strategy_library_entries_short_length" CHECK (char_length("strategy_library_entries"."short_description") between 1 and 280),
	CONSTRAINT "strategy_library_entries_prose" CHECK (char_length(btrim("strategy_library_entries"."entry")) > 0 and char_length(btrim("strategy_library_entries"."exit")) > 0 and char_length(btrim("strategy_library_entries"."assets")) > 0 and char_length(btrim("strategy_library_entries"."long_description")) > 0),
	CONSTRAINT "strategy_library_entries_built_link" CHECK (("strategy_library_entries"."built_strategy_id" is null) = ("strategy_library_entries"."built_strategy_owner" is null)),
	CONSTRAINT "strategy_library_entries_tags_count" CHECK (coalesce(array_length("strategy_library_entries"."tags", 1), 0) <= 20)
);
--> statement-breakpoint
CREATE TABLE "strategy_library_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entry_id" uuid NOT NULL,
	"action" text NOT NULL,
	"note" text NOT NULL,
	"changed_fields" text[] DEFAULT '{}'::text[] NOT NULL,
	"edited_by" uuid,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "strategy_library_revisions_action" CHECK ("strategy_library_revisions"."action" in ('edit', 'retire')),
	CONSTRAINT "strategy_library_revisions_note" CHECK (char_length(btrim("strategy_library_revisions"."note")) between 1 and 500)
);
--> statement-breakpoint
CREATE TABLE "strategy_library_sequence" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_issued" integer NOT NULL,
	CONSTRAINT "strategy_library_sequence_single" CHECK ("strategy_library_sequence"."id" = 1),
	CONSTRAINT "strategy_library_sequence_nonnegative" CHECK ("strategy_library_sequence"."last_issued" >= 0)
);
--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_convention_version_convention_versions_label_fk" FOREIGN KEY ("convention_version") REFERENCES "public"."convention_versions"("label") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_retired_by_user_id_fk" FOREIGN KEY ("retired_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_registered_by_user_id_fk" FOREIGN KEY ("registered_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_library_revisions" ADD CONSTRAINT "strategy_library_revisions_entry_id_strategy_library_entries_id_fk" FOREIGN KEY ("entry_id") REFERENCES "public"."strategy_library_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_library_revisions" ADD CONSTRAINT "strategy_library_revisions_edited_by_user_id_fk" FOREIGN KEY ("edited_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_library_entries_number_uq" ON "strategy_library_entries" USING btree ("registration_number");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_library_entries_sequence_uq" ON "strategy_library_entries" USING btree ("sequence_no");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_library_entries_seed_uq" ON "strategy_library_entries" USING btree ("seed_key");--> statement-breakpoint
CREATE INDEX "strategy_library_revisions_entry_idx" ON "strategy_library_revisions" USING btree ("entry_id","edited_at");
--> statement-breakpoint
-- Strategy Library (ADR 0051). A shared catalogue: rows are visible to every
-- signed-in session and any signed-in user may register or edit; registrant
-- and editors are recorded. Numbers are issued here, by the insert trigger,
-- from the convention version in effect and the single global sequence, in the
-- same transaction as the entry. A rolled-back registration rolls the sequence
-- back too, so no number is skipped or handed out twice.
INSERT INTO "convention_versions" ("label", "effective_from", "tables") VALUES ('v1', '2026-11-07', '{
  "recordType": [
    {"code": "S", "meaning": "Strategy", "note": "The only record type in v1. Other types require a new convention version."}
  ],
  "timeframe": [
    {"code": "S", "meaning": "Seconds", "note": "Tick / sub-minute decisions"},
    {"code": "N", "meaning": "Minutes", "note": "N for miNutes; M is reserved for months"},
    {"code": "H", "meaning": "Hours", "note": "Intraday, hourly decisions"},
    {"code": "D", "meaning": "Days", "note": "Daily bars / daily decisions"},
    {"code": "W", "meaning": "Weeks", "note": "Weekly decisions"},
    {"code": "M", "meaning": "Months", "note": "Monthly decisions or rebalance"},
    {"code": "Q", "meaning": "Quarters", "note": "Quarterly decisions or rebalance"},
    {"code": "Y", "meaning": "Years", "note": "Yearly decisions or rebalance"}
  ],
  "assetClass": [
    {"code": "S", "meaning": "Stock", "note": "Single stocks or a stock universe"},
    {"code": "E", "meaning": "ETF"},
    {"code": "F", "meaning": "FX / currencies"},
    {"code": "U", "meaning": "Futures"},
    {"code": "O", "meaning": "Options"},
    {"code": "B", "meaning": "Bonds"},
    {"code": "C", "meaning": "Crypto"},
    {"code": "G", "meaning": "Commodities (Goods)"},
    {"code": "A", "meaning": "Multi-asset", "note": "Trades more than one class above"}
  ]
}');--> statement-breakpoint
INSERT INTO "strategy_library_sequence" ("id", "last_issued") VALUES (1, 0);--> statement-breakpoint
CREATE FUNCTION strategy_library_issue_number()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_tables jsonb;
  v_seq integer;
BEGIN
  SELECT label, tables INTO v_label, v_tables FROM convention_versions
   WHERE effective_from <= (now() AT TIME ZONE 'UTC')::date
   ORDER BY effective_from DESC, created_at DESC
   LIMIT 1;
  IF v_label IS NULL THEN
    RAISE EXCEPTION 'no convention version is in effect' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT v_tables->'recordType' @> jsonb_build_array(jsonb_build_object('code', NEW.record_type_code::text))
     OR NOT v_tables->'timeframe' @> jsonb_build_array(jsonb_build_object('code', NEW.timeframe_code::text))
     OR NOT v_tables->'assetClass' @> jsonb_build_array(jsonb_build_object('code', NEW.asset_class_code::text)) THEN
    RAISE EXCEPTION 'code not in convention %', v_label USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The row lock queues simultaneous registrations; each takes the next number.
  UPDATE strategy_library_sequence SET last_issued = last_issued + 1 WHERE id = 1
    RETURNING last_issued INTO v_seq;
  NEW.sequence_no := v_seq;
  NEW.convention_version := v_label;
  NEW.registration_number := NEW.record_type_code::text || NEW.timeframe_code::text
    || NEW.asset_class_code::text || '-' || lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');
  NEW.status := 'registered';
  NEW.retired_reason := NULL;
  NEW.retired_at := NULL;
  NEW.retired_by := NULL;
  NEW.registered_at := now();
  NEW.updated_at := now();
  NEW.updated_by := NEW.registered_by;
  NEW.row_version := 1;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION strategy_library_issue_number() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER strategy_library_entries_issue BEFORE INSERT ON "strategy_library_entries"
  FOR EACH ROW EXECUTE FUNCTION strategy_library_issue_number();--> statement-breakpoint
-- The number, the version that issued it, its letters and who registered it
-- never change. A retired entry stays retired: a returning strategy is
-- registered again under a new number.
CREATE FUNCTION strategy_library_guard_update()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NEW.registration_number <> OLD.registration_number
     OR NEW.sequence_no <> OLD.sequence_no
     OR NEW.convention_version <> OLD.convention_version
     OR NEW.record_type_code <> OLD.record_type_code
     OR NEW.timeframe_code <> OLD.timeframe_code
     OR NEW.asset_class_code <> OLD.asset_class_code
     OR NEW.registered_at <> OLD.registered_at
     OR NEW.seed_key IS DISTINCT FROM OLD.seed_key
     OR (NEW.registered_by IS DISTINCT FROM OLD.registered_by AND NEW.registered_by IS NOT NULL) THEN
    RAISE EXCEPTION 'a registration number and how it was issued never change'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A strategy link names a strategy in the linker's own workspace.
  IF (NEW.built_strategy_id, NEW.built_strategy_owner) IS DISTINCT FROM (OLD.built_strategy_id, OLD.built_strategy_owner)
     AND NEW.built_strategy_owner IS DISTINCT FROM app_current_user_id()
     AND NEW.built_strategy_owner IS NOT NULL THEN
    RAISE EXCEPTION 'link a strategy from your own workspace' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'retired' AND NEW.status <> 'retired' THEN
    RAISE EXCEPTION 'a retired entry is not revived; register it again under a new number'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER strategy_library_entries_guard BEFORE UPDATE ON "strategy_library_entries"
  FOR EACH ROW EXECUTE FUNCTION strategy_library_guard_update();--> statement-breakpoint
-- No hard delete: numbers are never freed. Convention versions are never
-- edited in place (a change is a new version), and the history is append-only.
CREATE FUNCTION strategy_library_reject_change()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
BEGIN
  -- A deleted user's id may be cleared from the history (ON DELETE SET NULL).
  -- (Nested: plpgsql does not promise to stop at the first false condition.)
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'strategy_library_revisions' THEN
    IF to_jsonb(NEW) ->> 'edited_by' IS NULL
       AND (to_jsonb(NEW) - 'edited_by') = (to_jsonb(OLD) - 'edited_by') THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION '% does not allow %', TG_TABLE_NAME, lower(TG_OP)
    USING ERRCODE = 'insufficient_privilege';
END;
$$;--> statement-breakpoint
CREATE TRIGGER strategy_library_entries_no_delete BEFORE DELETE ON "strategy_library_entries"
  FOR EACH ROW EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
CREATE TRIGGER strategy_library_entries_no_truncate BEFORE TRUNCATE ON "strategy_library_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
CREATE TRIGGER convention_versions_immutable BEFORE UPDATE OR DELETE ON "convention_versions"
  FOR EACH ROW EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
CREATE TRIGGER convention_versions_no_truncate BEFORE TRUNCATE ON "convention_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
CREATE TRIGGER strategy_library_sequence_no_delete BEFORE DELETE ON "strategy_library_sequence"
  FOR EACH ROW EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
CREATE TRIGGER strategy_library_sequence_no_truncate BEFORE TRUNCATE ON "strategy_library_sequence"
  FOR EACH STATEMENT EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
CREATE TRIGGER strategy_library_revisions_append_only BEFORE UPDATE OR DELETE ON "strategy_library_revisions"
  FOR EACH ROW EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
CREATE TRIGGER strategy_library_revisions_no_truncate BEFORE TRUNCATE ON "strategy_library_revisions"
  FOR EACH STATEMENT EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
-- Shared, not tenant data, but only inside a signed-in session: every policy
-- needs app.user_id, and what a person writes carries their own id.
ALTER TABLE "strategy_library_entries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY library_read ON "strategy_library_entries" FOR SELECT TO tm_app
  USING (app_current_user_id() IS NOT NULL);--> statement-breakpoint
CREATE POLICY library_register ON "strategy_library_entries" FOR INSERT TO tm_app
  WITH CHECK (registered_by = app_current_user_id() AND seed_key IS NULL
    AND (built_strategy_owner IS NULL OR built_strategy_owner = app_current_user_id()));--> statement-breakpoint
CREATE POLICY library_edit ON "strategy_library_entries" FOR UPDATE TO tm_app
  USING (app_current_user_id() IS NOT NULL)
  WITH CHECK (updated_by = app_current_user_id());--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "strategy_library_entries" TO tm_app;--> statement-breakpoint
ALTER TABLE "strategy_library_revisions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY library_history_read ON "strategy_library_revisions" FOR SELECT TO tm_app
  USING (app_current_user_id() IS NOT NULL);--> statement-breakpoint
CREATE POLICY library_history_append ON "strategy_library_revisions" FOR INSERT TO tm_app
  WITH CHECK (edited_by = app_current_user_id());--> statement-breakpoint
GRANT SELECT, INSERT ON "strategy_library_revisions" TO tm_app;--> statement-breakpoint
GRANT SELECT ON "convention_versions" TO tm_app;--> statement-breakpoint
GRANT SELECT ON "strategy_library_sequence" TO tm_app;
