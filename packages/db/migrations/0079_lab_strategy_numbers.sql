CREATE TABLE "strategy_lab_sequence" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_issued" integer NOT NULL,
	CONSTRAINT "strategy_lab_sequence_single" CHECK ("strategy_lab_sequence"."id" = 1),
	CONSTRAINT "strategy_lab_sequence_nonnegative" CHECK ("strategy_lab_sequence"."last_issued" >= 0)
);
--> statement-breakpoint
ALTER TABLE "strategy" ADD COLUMN "lab_number" text;--> statement-breakpoint
ALTER TABLE "strategy" ADD COLUMN "lab_sequence_no" integer;--> statement-breakpoint
ALTER TABLE "strategy" ADD COLUMN "lab_timeframe_code" text;--> statement-breakpoint
ALTER TABLE "strategy" ADD COLUMN "lab_asset_class_code" text;--> statement-breakpoint
ALTER TABLE "strategy" ADD COLUMN "lab_convention_version" text;--> statement-breakpoint
ALTER TABLE "strategy" ADD COLUMN "lab_numbered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "strategy" ADD CONSTRAINT "strategy_lab_convention_version_convention_versions_label_fk" FOREIGN KEY ("lab_convention_version") REFERENCES "public"."convention_versions"("label") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_lab_number_uq" ON "strategy" USING btree ("lab_number");--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_lab_sequence_uq" ON "strategy" USING btree ("lab_sequence_no");--> statement-breakpoint
ALTER TABLE "strategy" ADD CONSTRAINT "strategy_lab_number_shape" CHECK ("strategy"."lab_number" is null or ("strategy"."lab_number" = 'S' || lpad("strategy"."lab_sequence_no"::text, greatest(5, length("strategy"."lab_sequence_no"::text)), '0') || '-' || "strategy"."lab_asset_class_code" || "strategy"."lab_timeframe_code" and "strategy"."lab_convention_version" is not null and "strategy"."lab_numbered_at" is not null));--> statement-breakpoint
-- Strategy Lab numbers (ADR 0065, N182). A Lab strategy gets a number of its
-- own, laid out by the theory rules (convention v3: sequence-first, five
-- digits, asset class and timeframe letters from the version's tables) with
-- record type S, from the Lab's own counter. The app sets the two letters on
-- the first save with instruments; this trigger issues the number in the same
-- transaction, so a rolled-back save rolls the counter back too. Once issued,
-- the number and its letters never change, and a number is never reused.
--
-- Theory numbers were S numbers until convention v3 (ADR 0064) and still
-- resolve as former numbers, so the counter never issues a sequence at or
-- below the highest theory sequence that has ever had an S number: no string
-- names both a theory and a strategy.
INSERT INTO "strategy_lab_sequence" ("id", "last_issued") VALUES (1, 0);--> statement-breakpoint
CREATE FUNCTION strategy_lab_issue_number()
  RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_label text;
  v_tables jsonb;
  v_floor integer;
  v_seq integer;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.lab_number IS NOT NULL THEN
    IF (NEW.lab_number, NEW.lab_sequence_no, NEW.lab_timeframe_code, NEW.lab_asset_class_code,
        NEW.lab_convention_version, NEW.lab_numbered_at)
       IS DISTINCT FROM
       (OLD.lab_number, OLD.lab_sequence_no, OLD.lab_timeframe_code, OLD.lab_asset_class_code,
        OLD.lab_convention_version, OLD.lab_numbered_at) THEN
      RAISE EXCEPTION 'a Strategy Lab number and its letters never change'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;
  -- Only this trigger issues: whatever the statement wrote is replaced.
  NEW.lab_number := NULL;
  NEW.lab_sequence_no := NULL;
  NEW.lab_convention_version := NULL;
  NEW.lab_numbered_at := NULL;
  IF NEW.lab_timeframe_code IS NULL AND NEW.lab_asset_class_code IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.lab_timeframe_code IS NULL OR NEW.lab_asset_class_code IS NULL THEN
    RAISE EXCEPTION 'a Strategy Lab number needs both its timeframe and asset-class letters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT label, tables INTO v_label, v_tables FROM convention_versions
   WHERE effective_from <= (now() AT TIME ZONE 'UTC')::date
   ORDER BY effective_from DESC, created_at DESC
   LIMIT 1;
  IF v_label IS NULL THEN
    RAISE EXCEPTION 'no convention version is in effect' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF NOT v_tables->'timeframe' @> jsonb_build_array(jsonb_build_object('code', NEW.lab_timeframe_code))
     OR NOT v_tables->'assetClass' @> jsonb_build_array(jsonb_build_object('code', NEW.lab_asset_class_code)) THEN
    RAISE EXCEPTION 'code not in convention %', v_label USING ERRCODE = 'invalid_parameter_value';
  END IF;
  -- The highest theory sequence that has had an S number, now or formerly.
  SELECT coalesce(max(e.sequence_no), 0) INTO v_floor
    FROM strategy_library_entries e
   WHERE e.registration_number ~ '^S[0-9]'
      OR EXISTS (SELECT 1 FROM unnest(e.former_numbers) f WHERE f ~ '^S[0-9]');
  -- The row lock queues simultaneous saves; each takes the next number.
  UPDATE strategy_lab_sequence SET last_issued = greatest(last_issued, v_floor) + 1 WHERE id = 1
    RETURNING last_issued INTO v_seq;
  NEW.lab_sequence_no := v_seq;
  NEW.lab_convention_version := v_label;
  NEW.lab_number := strategy_library_compose('sequence-first', 5, 'S',
    NEW.lab_timeframe_code, NEW.lab_asset_class_code, v_seq);
  NEW.lab_numbered_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION strategy_lab_issue_number() FROM PUBLIC;--> statement-breakpoint
CREATE TRIGGER strategy_lab_number BEFORE INSERT OR UPDATE ON "strategy"
  FOR EACH ROW EXECUTE FUNCTION strategy_lab_issue_number();--> statement-breakpoint
CREATE TRIGGER strategy_lab_sequence_no_delete BEFORE DELETE ON "strategy_lab_sequence"
  FOR EACH ROW EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
CREATE TRIGGER strategy_lab_sequence_no_truncate BEFORE TRUNCATE ON "strategy_lab_sequence"
  FOR EACH STATEMENT EXECUTE FUNCTION strategy_library_reject_change();--> statement-breakpoint
GRANT SELECT ON "strategy_lab_sequence" TO tm_app;
