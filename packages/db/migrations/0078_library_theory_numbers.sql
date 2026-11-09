-- Library entries are theories (N181): convention v3 issues the record-type
-- letter T (Theory) instead of S. The v3 row and the renumbering itself are
-- written by renumberToTheories (src/library-theory.ts) right after the
-- migrations, in one transaction, as the v2 renumbering was. This migration
-- only lets the single exempt renumber path change the record-type letter:
-- when the target version does not have the entry's letter and has exactly
-- one record type, the entry takes that one. Nothing else may change it.
CREATE OR REPLACE FUNCTION strategy_library_renumber(p_entry uuid, p_version text)
  RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  r strategy_library_entries%ROWTYPE;
  v convention_versions%ROWTYPE;
  v_record text;
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
  v_record := r.record_type_code::text;
  IF NOT v.tables->'recordType' @> jsonb_build_array(jsonb_build_object('code', v_record))
     AND jsonb_array_length(v.tables->'recordType') = 1 THEN
    v_record := v.tables->'recordType'->0->>'code';
  END IF;
  IF NOT v.tables->'recordType' @> jsonb_build_array(jsonb_build_object('code', v_record))
     OR NOT v.tables->'timeframe' @> jsonb_build_array(jsonb_build_object('code', r.timeframe_code::text))
     OR NOT v.tables->'assetClass' @> jsonb_build_array(jsonb_build_object('code', r.asset_class_code::text)) THEN
    RAISE EXCEPTION '% has a code not in convention %', r.registration_number, p_version
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_new := strategy_library_compose(v.layout, v.sequence_digits, v_record,
    r.timeframe_code::text, r.asset_class_code::text, r.sequence_no);
  PERFORM set_config('tm.library_renumber', p_entry::text, true);
  UPDATE strategy_library_entries
     SET registration_number = v_new,
         record_type_code = v_record,
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
-- The guard, as in 0070, except that the record-type letter may change too,
-- but only on the renumber path.
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
     OR NEW.timeframe_code <> OLD.timeframe_code
     OR NEW.asset_class_code <> OLD.asset_class_code
     OR NEW.registered_at <> OLD.registered_at
     OR NEW.seed_key IS DISTINCT FROM OLD.seed_key
     OR (NEW.registered_by IS DISTINCT FROM OLD.registered_by AND NEW.registered_by IS NOT NULL)
     OR (NOT v_renumber AND (NEW.registration_number <> OLD.registration_number
         OR NEW.record_type_code <> OLD.record_type_code
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
$$;
