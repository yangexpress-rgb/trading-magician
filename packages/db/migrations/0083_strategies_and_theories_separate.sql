DROP INDEX "strategy_share_pending_uq";--> statement-breakpoint
ALTER TABLE "strategy_share" ALTER COLUMN "source_entry_id" DROP NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_share_pending_uq" ON "strategy_share" USING btree ("sender_id","recipient_id",coalesce("source_strategy_id", "source_entry_id")) WHERE "strategy_share"."status" = 'pending';--> statement-breakpoint
ALTER TABLE "strategy_share" ADD CONSTRAINT "strategy_share_library_source" CHECK ("strategy_share"."kind" <> 'library' or "strategy_share"."source_entry_id" is not null);--> statement-breakpoint
-- Strategies and theories are separate objects (N205, ADR 0072). A save no
-- longer creates a theory; a strategy refers to any theory, or to none.
-- Records auto-created before this stay, and so do their links (Yong's choice,
-- O141): each such strategy now shows that record as its theory. No data changes.
-- A strategy is shared with or without a theory (ADR 0072): a Lab share names
-- the theory the strategy refers to (or none) and shows the strategy's own S
-- number. Otherwise share_create is as in 0074.
CREATE OR REPLACE FUNCTION share_create(
  p_recipient uuid, p_kind text, p_source_entry uuid, p_source_strategy uuid,
  p_snapshot jsonb, p_note text
) RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_caller uuid := share_caller();
  v_sender record;
  v_recipient record;
  v_entry record;
  v_number text;
  v_name text;
  v_id uuid;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
BEGIN
  PERFORM set_config('tm.sharing', 'on', true);
  SELECT u.member_code AS code, coalesce(p.display_name, u.name) AS name,
         EXISTS (SELECT 1 FROM platform_admin a WHERE a.user_id = u.id) AS is_admin
    INTO v_sender
    FROM "user" u LEFT JOIN profile p ON p.user_id = u.id
   WHERE u.id = v_caller;
  SELECT u.member_code AS code, coalesce(p.display_name, u.name) AS name
    INTO v_recipient
    FROM "user" u LEFT JOIN profile p ON p.user_id = u.id
   WHERE u.id = p_recipient AND u.deleted_at IS NULL AND u.locked_at IS NULL
     AND u.id <> v_caller;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'this member can''t receive shares' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_source_entry IS NOT NULL THEN
    SELECT e.registration_number, e.name, e.status INTO v_entry
      FROM strategy_library_entries e WHERE e.id = p_source_entry;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'that Library record doesn''t exist' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  IF p_kind = 'library' THEN
    IF p_source_strategy IS NOT NULL OR p_source_entry IS NULL THEN
      RAISE EXCEPTION 'a Library share names one record and no strategy' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_entry.status <> 'registered' THEN
      RAISE EXCEPTION 'retired records can''t be shared' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    v_number := v_entry.registration_number;
    v_name := v_entry.name;
  ELSIF p_kind = 'lab' THEN
    SELECT s.lab_number, s.name INTO v_number, v_name FROM strategy s
     WHERE s.id = p_source_strategy AND s.user_id = v_caller AND s.deleted_at IS NULL
       AND s.lab_number IS NOT NULL
       AND s.library_entry_id IS NOT DISTINCT FROM p_source_entry;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'share one of your own numbered strategies' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown share kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF char_length(coalesce(v_note, '')) > 500 THEN
    RAISE EXCEPTION 'keep the note to 500 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  v_name := coalesce(p_snapshot #>> '{strategy,name}', v_name);
  BEGIN
    INSERT INTO strategy_share (
      kind, sender_id, recipient_id, sender_name, sender_code, sender_is_admin,
      recipient_name, recipient_code, source_entry_id, source_number, source_name,
      source_strategy_id, snapshot, note, expires_at
    ) VALUES (
      p_kind, v_caller, p_recipient, v_sender.name, v_sender.code, v_sender.is_admin,
      v_recipient.name, v_recipient.code, p_source_entry, v_number, v_name,
      p_source_strategy, p_snapshot, v_note, now() + interval '30 days'
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already shared with %, waiting for an answer', v_recipient.code
      USING ERRCODE = 'invalid_parameter_value';
  END;
  PERFORM share_notify(
    p_recipient, 'share_received',
    share_person(v_sender.name, v_sender.code) || ' shared ' || v_number || ' ' || v_name
      || ' with you',
    coalesce(v_note, ''), v_id);
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES
    (v_caller, 'user', 'strategy.shared', 'strategy_share', v_id,
     jsonb_build_object('kind', p_kind, 'number', v_number, 'to', v_recipient.code)),
    (p_recipient, 'system', 'share.received', 'strategy_share', v_id,
     jsonb_build_object('kind', p_kind, 'number', v_number, 'from', v_sender.code));
  PERFORM set_config('tm.sharing', '', true);
  RETURN v_id;
END
$$;
--> statement-breakpoint
-- Second half of an accept (ADR 0072). A Library share records the copied
-- record, as before. A Lab share records the recipient's strategy copy, which
-- refers to the shared strategy's theory (or to none, or to none when that
-- theory was retired since) and is known by its own S number.
CREATE OR REPLACE FUNCTION share_accept_finish(p_share uuid, p_entry uuid, p_strategy uuid)
  RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_caller uuid := share_caller();
  v_row strategy_share;
  v_number text;
BEGIN
  PERFORM set_config('tm.sharing', 'on', true);
  SELECT * INTO v_row FROM strategy_share s
   WHERE s.id = p_share AND s.recipient_id = v_caller AND s.status = 'pending'
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.kind = 'library' THEN
    SELECT e.registration_number INTO v_number FROM strategy_library_entries e
     WHERE e.id = p_entry AND e.received_share_id = p_share AND e.registered_by = v_caller;
    IF NOT FOUND OR p_strategy IS NOT NULL THEN
      RAISE EXCEPTION 'the copied record is missing' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    IF p_entry IS NOT NULL AND p_entry IS DISTINCT FROM v_row.source_entry_id THEN
      RAISE EXCEPTION 'the copy refers to another theory' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    SELECT s.lab_number INTO v_number FROM strategy s
     WHERE s.id = p_strategy AND s.user_id = v_caller AND s.received_share_id = p_share
       AND s.library_entry_id IS NOT DISTINCT FROM p_entry AND s.lab_number IS NOT NULL;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'the copied strategy is missing' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  END IF;
  UPDATE strategy_share
     SET status = 'accepted', decided_at = now(), result_entry_id = p_entry,
         result_strategy_id = p_strategy, result_number = v_number
   WHERE id = p_share;
  PERFORM share_notify(
    v_row.sender_id, 'share_accepted',
    share_person(v_row.recipient_name, v_row.recipient_code) || ' accepted ' || v_row.source_number
      || '; their copy is ' || v_number,
    '', p_share);
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES
    (v_caller, 'user', 'share.accepted', 'strategy_share', p_share,
     jsonb_build_object('number', v_row.source_number, 'copy', v_number, 'from', v_row.sender_code));
  IF v_row.sender_id IS NOT NULL THEN
    INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
    VALUES (v_row.sender_id, 'system', 'share.accepted', 'strategy_share', p_share,
            jsonb_build_object('number', v_row.source_number, 'by', v_row.recipient_code));
  END IF;
  PERFORM set_config('tm.sharing', '', true);
END
$$;
