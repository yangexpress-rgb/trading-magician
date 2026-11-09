-- Strategy Lab numbers start at S00001 (N183, ADR 0066). Yong chose to keep
-- the theory and strategy number ranges separate: the Lab counter no longer
-- starts above the former S theory numbers. The issuing trigger is the same as
-- in 0079 without that floor.
CREATE OR REPLACE FUNCTION strategy_lab_issue_number()
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
  -- The row lock queues simultaneous saves; each takes the next number.
  UPDATE strategy_lab_sequence SET last_issued = last_issued + 1 WHERE id = 1
    RETURNING last_issued INTO v_seq;
  NEW.lab_sequence_no := v_seq;
  NEW.lab_convention_version := v_label;
  NEW.lab_number := strategy_library_compose('sequence-first', 5, 'S',
    NEW.lab_timeframe_code, NEW.lab_asset_class_code, v_seq);
  NEW.lab_numbered_at := now();
  RETURN NEW;
END;
$$;--> statement-breakpoint
-- The Lab numbers already issued (from S00032 on staging) are renumbered once,
-- from S00001 in the order they were issued, keeping their letters, and the
-- counter continues after the last. The guard trigger and updated_at are off
-- for this one statement pair only; a number is otherwise never changed.
ALTER TABLE "strategy" DISABLE TRIGGER strategy_lab_number;--> statement-breakpoint
ALTER TABLE "strategy" DISABLE TRIGGER strategy_set_updated_at;--> statement-breakpoint
-- Two steps, so no new number meets an old one in the unique indexes.
UPDATE "strategy" SET
  lab_sequence_no = lab_sequence_no + 1000000,
  lab_number = strategy_library_compose('sequence-first', 5, 'S',
    lab_timeframe_code, lab_asset_class_code, lab_sequence_no + 1000000)
 WHERE lab_number IS NOT NULL;--> statement-breakpoint
UPDATE "strategy" s SET
  lab_sequence_no = r.n,
  lab_number = strategy_library_compose('sequence-first', 5, 'S',
    s.lab_timeframe_code, s.lab_asset_class_code, r.n)
  FROM (SELECT id, row_number() OVER (ORDER BY lab_sequence_no)::integer AS n
          FROM "strategy" WHERE lab_number IS NOT NULL) r
 WHERE s.id = r.id;--> statement-breakpoint
UPDATE "strategy_lab_sequence" SET last_issued =
  (SELECT count(*) FROM "strategy" WHERE lab_number IS NOT NULL) WHERE id = 1;--> statement-breakpoint
ALTER TABLE "strategy" ENABLE TRIGGER strategy_set_updated_at;--> statement-breakpoint
ALTER TABLE "strategy" ENABLE TRIGGER strategy_lab_number;
