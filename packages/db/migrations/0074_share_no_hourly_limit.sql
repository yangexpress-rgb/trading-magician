-- O104 amended: Yong removed the sharing limits (2026-11-08): no hourly limit
-- and no pending limit (the app also drops its 10 people and 20 strategies a
-- send). Otherwise share_create is as in 0073.
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
  SELECT e.registration_number, e.name, e.status INTO v_entry
    FROM strategy_library_entries e WHERE e.id = p_source_entry;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'that Library record doesn''t exist' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_kind = 'library' THEN
    IF p_source_strategy IS NOT NULL THEN
      RAISE EXCEPTION 'a Library share names no strategy' USING ERRCODE = 'invalid_parameter_value';
    END IF;
    IF v_entry.status <> 'registered' THEN
      RAISE EXCEPTION 'retired records can''t be shared' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSIF p_kind = 'lab' THEN
    IF NOT EXISTS (
      SELECT 1 FROM strategy s
       WHERE s.id = p_source_strategy AND s.user_id = v_caller AND s.deleted_at IS NULL
         AND s.library_entry_id = p_source_entry
    ) THEN
      RAISE EXCEPTION 'share one of your own numbered strategies' USING ERRCODE = 'invalid_parameter_value';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown share kind' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF char_length(coalesce(v_note, '')) > 500 THEN
    RAISE EXCEPTION 'keep the note to 500 characters' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  BEGIN
    INSERT INTO strategy_share (
      kind, sender_id, recipient_id, sender_name, sender_code, sender_is_admin,
      recipient_name, recipient_code, source_entry_id, source_number, source_name,
      source_strategy_id, snapshot, note, expires_at
    ) VALUES (
      p_kind, v_caller, p_recipient, v_sender.name, v_sender.code, v_sender.is_admin,
      v_recipient.name, v_recipient.code, p_source_entry, v_entry.registration_number,
      coalesce(p_snapshot #>> '{strategy,name}', v_entry.name),
      p_source_strategy, p_snapshot, v_note, now() + interval '30 days'
    ) RETURNING id INTO v_id;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'already shared with %, waiting for an answer', v_recipient.code
      USING ERRCODE = 'invalid_parameter_value';
  END;
  PERFORM share_notify(
    p_recipient, 'share_received',
    share_person(v_sender.name, v_sender.code) || ' shared ' || v_entry.registration_number || ' '
      || coalesce(p_snapshot #>> '{strategy,name}', v_entry.name) || ' with you',
    coalesce(v_note, ''), v_id);
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES
    (v_caller, 'user', 'strategy.shared', 'strategy_share', v_id,
     jsonb_build_object('kind', p_kind, 'number', v_entry.registration_number, 'to', v_recipient.code)),
    (p_recipient, 'system', 'share.received', 'strategy_share', v_id,
     jsonb_build_object('kind', p_kind, 'number', v_entry.registration_number, 'from', v_sender.code));
  PERFORM set_config('tm.sharing', '', true);
  RETURN v_id;
END
$$;
