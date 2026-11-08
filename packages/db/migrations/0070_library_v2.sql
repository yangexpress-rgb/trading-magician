ALTER TABLE "strategy_library_entries" DROP CONSTRAINT "strategy_library_entries_number_shape";--> statement-breakpoint
ALTER TABLE "convention_versions" ADD COLUMN "layout" text DEFAULT 'letters-first' NOT NULL;--> statement-breakpoint
ALTER TABLE "convention_versions" ADD COLUMN "sequence_digits" integer DEFAULT 4 NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "former_numbers" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "parameters" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "position_sizing" jsonb;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "stop_loss" jsonb;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "rebalance_schedule" jsonb;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "maturity" text DEFAULT 'researched' NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "key_risks" text;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "data_needs" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "universe" jsonb;--> statement-breakpoint
CREATE INDEX "strategy_library_entries_former_idx" ON "strategy_library_entries" USING gin ("former_numbers");--> statement-breakpoint
ALTER TABLE "convention_versions" ADD CONSTRAINT "convention_versions_layout" CHECK ("convention_versions"."layout" in ('letters-first', 'sequence-first'));--> statement-breakpoint
ALTER TABLE "convention_versions" ADD CONSTRAINT "convention_versions_digits" CHECK ("convention_versions"."sequence_digits" between 1 and 9);--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_direction" CHECK ("strategy_library_entries"."direction" is null or "strategy_library_entries"."direction" in ('long_only', 'short_only', 'long_short', 'market_neutral'));--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_maturity" CHECK ("strategy_library_entries"."maturity" in ('researched', 'backtested', 'paper_trading', 'live'));--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_data_needs" CHECK ("strategy_library_entries"."data_needs" <@ array['daily_bars', 'intraday_bars', 'fundamentals', 'options_chains', 'earnings_consensus', 'news', 'level2_tick', 'short_borrow', 'index_data']::text[]);--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_parameters" CHECK (jsonb_typeof("strategy_library_entries"."parameters") = 'array' and jsonb_array_length("strategy_library_entries"."parameters") <= 10);--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_key_risks" CHECK ("strategy_library_entries"."key_risks" is null or char_length("strategy_library_entries"."key_risks") <= 4000);--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_number_shape" CHECK ("strategy_library_entries"."registration_number" = "strategy_library_entries"."record_type_code" || "strategy_library_entries"."timeframe_code" || "strategy_library_entries"."asset_class_code" || '-' || lpad("strategy_library_entries"."sequence_no"::text, greatest(4, length("strategy_library_entries"."sequence_no"::text)), '0') or "strategy_library_entries"."registration_number" = "strategy_library_entries"."record_type_code" || lpad("strategy_library_entries"."sequence_no"::text, greatest(5, length("strategy_library_entries"."sequence_no"::text)), '0') || '-' || "strategy_library_entries"."asset_class_code" || "strategy_library_entries"."timeframe_code");--> statement-breakpoint
-- Strategy Library v2 (ADR 0055). Convention versions now say how they lay out
-- a number: v1 letters-first (SDS-0001), v2 sequence-first (S00001-SD). The
-- v2 row itself is added by the renumber migration (library:renumber-v2), in
-- the same transaction that renumbers the existing entries, so the library is
-- never half v1 and half v2. The sequence counter is untouched.
CREATE OR REPLACE FUNCTION strategy_library_issue_number()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_tables jsonb;
  v_layout text;
  v_digits integer;
  v_seq integer;
BEGIN
  SELECT label, tables, layout, sequence_digits INTO v_label, v_tables, v_layout, v_digits
    FROM convention_versions
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
  NEW.registration_number := strategy_library_compose(
    v_layout, v_digits, NEW.record_type_code::text, NEW.timeframe_code::text,
    NEW.asset_class_code::text, v_seq);
  NEW.former_numbers := '{}';
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
-- One place lays out a number (mirrors layoutNumber in @tm/domain).
CREATE FUNCTION strategy_library_compose(
  p_layout text, p_digits integer, p_record text, p_timeframe text, p_asset text, p_seq integer)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  AS $$
  SELECT CASE p_layout
    WHEN 'sequence-first' THEN
      p_record || lpad(p_seq::text, greatest(p_digits, length(p_seq::text)), '0') || '-' || p_asset || p_timeframe
    ELSE
      p_record || p_timeframe || p_asset || '-' || lpad(p_seq::text, greatest(p_digits, length(p_seq::text)), '0')
  END
$$;--> statement-breakpoint
-- The renumber migration: the single exempt path for changing a number. It
-- re-lays-out one entry's number under p_version from the entry's own stored
-- codes and sequence, appends the old number to former_numbers and bumps the
-- row version. Only the owner may run it (the app login has no EXECUTE).
CREATE FUNCTION strategy_library_renumber(p_entry uuid, p_version text)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  r strategy_library_entries%ROWTYPE;
  v convention_versions%ROWTYPE;
  v_new text;
BEGIN
  SELECT * INTO r FROM strategy_library_entries WHERE id = p_entry FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no library entry %', p_entry USING ERRCODE = 'no_data_found';
  END IF;
  SELECT * INTO v FROM convention_versions WHERE label = p_version;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'no convention version %', p_version USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF r.convention_version = p_version THEN
    RETURN r.registration_number;
  END IF;
  IF NOT v.tables->'recordType' @> jsonb_build_array(jsonb_build_object('code', r.record_type_code::text))
     OR NOT v.tables->'timeframe' @> jsonb_build_array(jsonb_build_object('code', r.timeframe_code::text))
     OR NOT v.tables->'assetClass' @> jsonb_build_array(jsonb_build_object('code', r.asset_class_code::text)) THEN
    RAISE EXCEPTION '% has a code not in convention %', r.registration_number, p_version
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_new := strategy_library_compose(v.layout, v.sequence_digits, r.record_type_code::text,
    r.timeframe_code::text, r.asset_class_code::text, r.sequence_no);
  PERFORM set_config('tm.library_renumber', p_entry::text, true);
  UPDATE strategy_library_entries
     SET registration_number = v_new,
         convention_version = p_version,
         former_numbers = former_numbers || r.registration_number,
         updated_at = now(),
         row_version = row_version + 1
   WHERE id = p_entry;
  PERFORM set_config('tm.library_renumber', '', true);
  RETURN v_new;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION strategy_library_renumber(uuid, text) FROM PUBLIC;--> statement-breakpoint
-- The guard, as in 0067, plus: former numbers only grow through the renumber
-- function above, which alone may change a number and its issuing version.
CREATE OR REPLACE FUNCTION strategy_library_guard_update()
  RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_renumber boolean;
BEGIN
  v_renumber := coalesce(current_setting('tm.library_renumber', true), '') = OLD.id::text
    AND current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
                         WHERE oid = 'strategy_library_renumber(uuid, text)'::regprocedure);
  IF NEW.sequence_no <> OLD.sequence_no
     OR NEW.record_type_code <> OLD.record_type_code
     OR NEW.timeframe_code <> OLD.timeframe_code
     OR NEW.asset_class_code <> OLD.asset_class_code
     OR NEW.registered_at <> OLD.registered_at
     OR NEW.seed_key IS DISTINCT FROM OLD.seed_key
     OR (NEW.registered_by IS DISTINCT FROM OLD.registered_by AND NEW.registered_by IS NOT NULL)
     OR (NOT v_renumber AND (NEW.registration_number <> OLD.registration_number
         OR NEW.convention_version <> OLD.convention_version
         OR NEW.former_numbers IS DISTINCT FROM OLD.former_numbers))
     OR (v_renumber AND NEW.former_numbers IS DISTINCT FROM OLD.former_numbers || OLD.registration_number) THEN
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
-- A former number belongs to exactly one entry and is never another entry's
-- current number.
CREATE FUNCTION strategy_library_former_unique()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF cardinality(NEW.former_numbers) <> (SELECT count(DISTINCT n) FROM unnest(NEW.former_numbers) n)
     OR NEW.registration_number = ANY (NEW.former_numbers)
     OR EXISTS (
       SELECT 1 FROM strategy_library_entries e
        WHERE e.id <> NEW.id
          AND (e.former_numbers && NEW.former_numbers
               OR e.registration_number = ANY (NEW.former_numbers)
               OR NEW.registration_number = ANY (e.former_numbers))) THEN
    RAISE EXCEPTION 'a former number belongs to one entry only' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION strategy_library_former_unique() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER strategy_library_entries_former_unique
  BEFORE INSERT OR UPDATE OF former_numbers, registration_number ON "strategy_library_entries"
  FOR EACH ROW EXECUTE FUNCTION strategy_library_former_unique();
