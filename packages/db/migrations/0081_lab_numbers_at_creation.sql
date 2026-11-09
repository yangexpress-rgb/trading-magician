ALTER TABLE "strategy" ADD COLUMN "lab_letters_settled" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Every strategy is numbered when it is created (N186, ADR 0068). A new draft
-- trades nothing yet, so its letters may be provisional (the default SD, with
-- lab_letters_settled false); the first save with instruments settles them.
-- Until then the trigger lets the two letters change and lays the number out
-- again from the same sequence; the digits, version and issue time never
-- change, and settled letters never change. Issuing is as in 0080.
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
    IF (NEW.lab_sequence_no, NEW.lab_convention_version, NEW.lab_numbered_at)
       IS DISTINCT FROM (OLD.lab_sequence_no, OLD.lab_convention_version, OLD.lab_numbered_at)
       OR (OLD.lab_letters_settled AND (
         (NEW.lab_number, NEW.lab_timeframe_code, NEW.lab_asset_class_code, NEW.lab_letters_settled)
         IS DISTINCT FROM
         (OLD.lab_number, OLD.lab_timeframe_code, OLD.lab_asset_class_code, OLD.lab_letters_settled))) THEN
      RAISE EXCEPTION 'a Strategy Lab number and its letters never change'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF OLD.lab_letters_settled THEN
      RETURN NEW;
    END IF;
    -- Provisional letters: they may change (or settle); the number follows them.
    SELECT tables INTO v_tables FROM convention_versions WHERE label = OLD.lab_convention_version;
    IF NOT coalesce(v_tables->'timeframe' @> jsonb_build_array(jsonb_build_object('code', NEW.lab_timeframe_code)), false)
       OR NOT coalesce(v_tables->'assetClass' @> jsonb_build_array(jsonb_build_object('code', NEW.lab_asset_class_code)), false) THEN
      RAISE EXCEPTION 'code not in convention %', OLD.lab_convention_version
        USING ERRCODE = 'invalid_parameter_value';
    END IF;
    NEW.lab_number := strategy_library_compose('sequence-first', 5, 'S',
      NEW.lab_timeframe_code, NEW.lab_asset_class_code, OLD.lab_sequence_no);
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
$$;
