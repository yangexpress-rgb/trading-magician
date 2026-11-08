CREATE TABLE "member_code_sequence" (
	"id" integer PRIMARY KEY NOT NULL,
	"last_issued" integer NOT NULL,
	CONSTRAINT "member_code_sequence_single" CHECK ("member_code_sequence"."id" = 1),
	CONSTRAINT "member_code_sequence_nonnegative" CHECK ("member_code_sequence"."last_issued" >= 0)
);
--> statement-breakpoint
CREATE TABLE "strategy_share" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"sender_id" uuid,
	"recipient_id" uuid,
	"sender_name" text,
	"sender_code" text NOT NULL,
	"sender_is_admin" boolean DEFAULT false NOT NULL,
	"recipient_name" text,
	"recipient_code" text NOT NULL,
	"source_entry_id" uuid NOT NULL,
	"source_number" text NOT NULL,
	"source_name" text NOT NULL,
	"source_strategy_id" uuid,
	"snapshot" jsonb NOT NULL,
	"note" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"result_strategy_id" uuid,
	"result_entry_id" uuid,
	"result_number" text,
	CONSTRAINT "strategy_share_kind" CHECK ("strategy_share"."kind" in ('library', 'lab')),
	CONSTRAINT "strategy_share_status" CHECK ("strategy_share"."status" in ('pending', 'accepted', 'declined', 'withdrawn', 'expired')),
	CONSTRAINT "strategy_share_lab_source" CHECK (("strategy_share"."kind" = 'lab') = ("strategy_share"."source_strategy_id" is not null)),
	CONSTRAINT "strategy_share_note_length" CHECK (char_length("strategy_share"."note") <= 500),
	CONSTRAINT "strategy_share_not_self" CHECK ("strategy_share"."sender_id" is distinct from "strategy_share"."recipient_id"),
	CONSTRAINT "strategy_share_decided" CHECK (("strategy_share"."status" = 'pending') = ("strategy_share"."decided_at" is null))
);
--> statement-breakpoint
ALTER TABLE "notification" DROP CONSTRAINT "notification_kind";--> statement-breakpoint
ALTER TABLE "strategy" ADD COLUMN "received_share_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "received_share_id" uuid;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD COLUMN "copied_from" text;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "member_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "strategy_share" ADD CONSTRAINT "strategy_share_sender_id_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_share" ADD CONSTRAINT "strategy_share_recipient_id_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_share" ADD CONSTRAINT "strategy_share_source_entry_id_strategy_library_entries_id_fk" FOREIGN KEY ("source_entry_id") REFERENCES "public"."strategy_library_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_share" ADD CONSTRAINT "strategy_share_result_entry_id_strategy_library_entries_id_fk" FOREIGN KEY ("result_entry_id") REFERENCES "public"."strategy_library_entries"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "strategy_share_pending_uq" ON "strategy_share" USING btree ("sender_id","recipient_id","source_entry_id") WHERE "strategy_share"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "strategy_share_recipient_idx" ON "strategy_share" USING btree ("recipient_id","created_at");--> statement-breakpoint
CREATE INDEX "strategy_share_sender_idx" ON "strategy_share" USING btree ("sender_id","created_at");--> statement-breakpoint
ALTER TABLE "strategy" ADD CONSTRAINT "strategy_received_share_id_strategy_share_id_fk" FOREIGN KEY ("received_share_id") REFERENCES "public"."strategy_share"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategy_library_entries" ADD CONSTRAINT "strategy_library_entries_received_share_id_strategy_share_id_fk" FOREIGN KEY ("received_share_id") REFERENCES "public"."strategy_share"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification" ADD CONSTRAINT "notification_kind" CHECK ("notification"."kind" in ('strategy_started', 'strategy_stopped', 'triggered', 'order_rejected', 'partial_fill', 'filled', 'disconnect', 'stale_data', 'risk_pause', 'reconciliation_mismatch', 'billing', 'share_received', 'share_accepted', 'share_declined'));--> statement-breakpoint
-- Strategy sharing (ADR 0056). A member sends a copy of a Library record or of
-- a Strategy Lab strategy to another member, who accepts or declines it.
--
-- Member IDs. Every account gets `U0001`, `U0002`, … in sign-up order from one
-- counter row (gapless, like the Library's), set by an insert trigger whatever
-- the insert sent, and never changed.
INSERT INTO "member_code_sequence" ("id", "last_issued") VALUES (1, 0);
--> statement-breakpoint
CREATE FUNCTION member_code_issue() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_next integer;
BEGIN
  UPDATE member_code_sequence SET last_issued = last_issued + 1 WHERE id = 1
    RETURNING last_issued INTO v_next;
  NEW.member_code := 'U' || lpad(v_next::text, 4, '0');
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION member_code_issue() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION member_code_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.member_code IS DISTINCT FROM OLD.member_code THEN
    RAISE EXCEPTION 'member IDs never change' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
-- Existing accounts, oldest first. The owner reads and writes "user" here under
-- a transaction-local marker that only the policies below honour.
DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY share_owner_read ON "user" FOR SELECT TO %I USING (current_setting(%L, true) = %L)',
    current_user, 'tm.sharing', 'on');
  EXECUTE format(
    'CREATE POLICY share_owner_codes ON "user" FOR UPDATE TO %I USING (current_setting(%L, true) = %L) WITH CHECK (current_setting(%L, true) = %L)',
    current_user, 'tm.sharing', 'on', 'tm.sharing', 'on');
  EXECUTE format(
    'CREATE POLICY share_owner_read ON "profile" FOR SELECT TO %I USING (current_setting(%L, true) = %L)',
    current_user, 'tm.sharing', 'on');
  EXECUTE format(
    'CREATE POLICY share_owner_read ON "strategy" FOR SELECT TO %I USING (current_setting(%L, true) = %L)',
    current_user, 'tm.sharing', 'on');
  -- Insert with ON CONFLICT also reads the conflicting row, so the owner needs both.
  EXECUTE format(
    'CREATE POLICY share_owner_notify ON "notification" FOR INSERT TO %I WITH CHECK (current_setting(%L, true) = %L)',
    current_user, 'tm.sharing', 'on');
  EXECUTE format(
    'CREATE POLICY share_owner_notify_read ON "notification" FOR SELECT TO %I USING (current_setting(%L, true) = %L)',
    current_user, 'tm.sharing', 'on');
  EXECUTE format(
    'CREATE POLICY share_owner_audit ON "audit_event" FOR INSERT TO %I WITH CHECK (current_setting(%L, true) = %L)',
    current_user, 'tm.sharing', 'on');
  PERFORM set_config('tm.sharing', 'on', true);
  WITH ordered AS (
    SELECT id, row_number() OVER (ORDER BY created_at, id) AS n FROM "user"
  )
  UPDATE "user" u SET member_code = 'U' || lpad(o.n::text, 4, '0')
    FROM ordered o WHERE u.id = o.id;
  UPDATE member_code_sequence SET last_issued = (SELECT count(*) FROM "user") WHERE id = 1;
  PERFORM set_config('tm.sharing', '', true);
END
$$;
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_member_code_unique" UNIQUE("member_code");
--> statement-breakpoint
ALTER TABLE "user" ADD CONSTRAINT "user_member_code_shape" CHECK ("member_code" ~ '^U[0-9]{4,}$');
--> statement-breakpoint
CREATE TRIGGER user_member_code BEFORE INSERT ON "user"
  FOR EACH ROW EXECUTE FUNCTION member_code_issue();
--> statement-breakpoint
CREATE TRIGGER user_member_code_guard BEFORE UPDATE OF member_code ON "user"
  FOR EACH ROW EXECUTE FUNCTION member_code_guard();
--> statement-breakpoint
-- Shares: readable by their two people only, written only by the functions
-- below (which run as the owner, whose own policy is open: only migrations,
-- operator scripts and these functions use that login).
ALTER TABLE "strategy_share" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "strategy_share" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY share_parties ON "strategy_share" FOR SELECT TO tm_app
  USING (sender_id = app_current_user_id() OR recipient_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT ON "strategy_share" TO tm_app;
--> statement-breakpoint
DO $$
BEGIN
  EXECUTE format('CREATE POLICY share_owner ON "strategy_share" TO %I USING (true) WITH CHECK (true)', current_user);
END
$$;
--> statement-breakpoint
-- A copy names its share once, at the moment it is made: the share must be one
-- the signed-in person is accepting. Afterwards the link never changes.
CREATE FUNCTION received_share_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.received_share_id IS NOT DISTINCT FROM OLD.received_share_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.received_share_id IS NOT NULL THEN
    RAISE EXCEPTION 'a received copy keeps its share' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.received_share_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM strategy_share s
     WHERE s.id = NEW.received_share_id
       AND s.recipient_id = app_current_user_id()
       AND s.status = 'pending'
  ) THEN
    RAISE EXCEPTION 'only the recipient of a pending share can make its copy'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER strategy_received_share BEFORE INSERT OR UPDATE OF received_share_id ON "strategy"
  FOR EACH ROW EXECUTE FUNCTION received_share_guard();
--> statement-breakpoint
CREATE TRIGGER library_received_share BEFORE INSERT OR UPDATE OF received_share_id ON "strategy_library_entries"
  FOR EACH ROW EXECUTE FUNCTION received_share_guard();
--> statement-breakpoint
-- The caller, or a refusal when no one is signed in.
CREATE FUNCTION share_caller() RETURNS uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_user uuid := app_current_user_id();
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'sign in to share' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN v_user;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_caller() FROM PUBLIC;
--> statement-breakpoint
-- A notification to either side, unless they muted the kind (as notify() does).
CREATE FUNCTION share_notify(
  p_user uuid, p_kind text, p_title text, p_body text, p_share uuid
) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_user IS NULL THEN
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM profile p
     WHERE p.user_id = p_user
       AND jsonb_typeof(p.notification_prefs -> 'muted') = 'array'
       AND (p.notification_prefs -> 'muted') ? p_kind
  ) THEN
    RETURN;
  END IF;
  INSERT INTO notification (user_id, kind, title, body, link, resource_type, resource_id, dedupe_key)
  VALUES (p_user, p_kind, left(p_title, 200), left(coalesce(p_body, ''), 1000),
          '/sharing/' || p_share::text, 'strategy_share', p_share, p_kind || ':' || p_share::text)
  ON CONFLICT (user_id, dedupe_key) DO NOTHING;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_notify(uuid, text, text, text, uuid) FROM PUBLIC;
--> statement-breakpoint
-- "Yong (U0001)", or "a former member (U0001)" once the name is gone.
CREATE FUNCTION share_person(p_name text, p_code text) RETURNS text
  LANGUAGE sql
  IMMUTABLE
  AS $$ SELECT coalesce(p_name, 'a former member') || ' (' || p_code || ')' $$;
--> statement-breakpoint
-- Finds one member by exact member ID or email; nothing for anyone who can't
-- receive shares (deleted, locked) or for the caller. One answer for every
-- miss, so a lookup can't tell why.
CREATE FUNCTION share_lookup_member(p_query text)
  RETURNS TABLE (user_id uuid, member_code text, display_name text, is_admin boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_caller uuid := share_caller();
  v_query text := btrim(coalesce(p_query, ''));
BEGIN
  IF v_query = '' THEN
    RETURN;
  END IF;
  PERFORM set_config('tm.sharing', 'on', true);
  RETURN QUERY
    SELECT u.id, u.member_code, coalesce(p.display_name, u.name),
           EXISTS (SELECT 1 FROM platform_admin a WHERE a.user_id = u.id)
      FROM "user" u
      LEFT JOIN profile p ON p.user_id = u.id
     WHERE (u.member_code = upper(v_query) OR lower(u.email) = lower(v_query))
       AND u.deleted_at IS NULL AND u.locked_at IS NULL AND u.id <> v_caller
     LIMIT 1;
  PERFORM set_config('tm.sharing', '', true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_lookup_member(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION share_lookup_member(text) TO tm_app;
--> statement-breakpoint
-- The admin's recipient picker: every member who can receive shares.
CREATE FUNCTION share_list_members()
  RETURNS TABLE (user_id uuid, member_code text, display_name text, is_admin boolean)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_caller uuid := share_caller();
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM set_config('tm.sharing', 'on', true);
  RETURN QUERY
    SELECT u.id, u.member_code, coalesce(p.display_name, u.name),
           EXISTS (SELECT 1 FROM platform_admin a WHERE a.user_id = u.id)
      FROM "user" u
      LEFT JOIN profile p ON p.user_id = u.id
     WHERE u.deleted_at IS NULL AND u.locked_at IS NULL AND u.id <> v_caller
     ORDER BY u.member_code;
  PERFORM set_config('tm.sharing', '', true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_list_members() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION share_list_members() TO tm_app;
--> statement-breakpoint
-- Makes one share. The app builds the snapshot from what the caller can read;
-- this checks the people, the source and the limits, names the sender from the
-- database, and tells the recipient.
CREATE FUNCTION share_create(
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
  IF (SELECT count(*) FROM strategy_share WHERE sender_id = v_caller AND status = 'pending') >= 50 THEN
    RAISE EXCEPTION 'you have 50 shares waiting for an answer; withdraw some first'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (SELECT count(*) FROM strategy_share
       WHERE sender_id = v_caller AND created_at > now() - interval '1 hour') >= 20 THEN
    RAISE EXCEPTION 'you can share 20 times an hour; try again later'
      USING ERRCODE = 'invalid_parameter_value';
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_create(uuid, text, uuid, uuid, jsonb, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION share_create(uuid, text, uuid, uuid, jsonb, text) TO tm_app;
--> statement-breakpoint
-- First half of an accept: locks the share for the rest of the transaction.
-- A pending share comes back for the app to copy; an accepted one comes back
-- as it is (a repeated accept returns the first copy); anything else refuses.
CREATE FUNCTION share_accept_begin(p_share uuid)
  RETURNS TABLE (
    kind text, status text, snapshot jsonb, source_number text, sender_code text,
    result_strategy_id uuid, result_entry_id uuid, result_number text
  )
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_caller uuid := share_caller();
  v_row strategy_share;
BEGIN
  SELECT * INTO v_row FROM strategy_share s
   WHERE s.id = p_share AND s.recipient_id = v_caller
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status = 'pending' AND v_row.expires_at <= now() THEN
    RAISE EXCEPTION 'this share has expired' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF v_row.status NOT IN ('pending', 'accepted') THEN
    RAISE EXCEPTION 'this share was %', v_row.status USING ERRCODE = 'invalid_parameter_value';
  END IF;
  RETURN QUERY SELECT v_row.kind, v_row.status, v_row.snapshot, v_row.source_number,
    v_row.sender_code, v_row.result_strategy_id, v_row.result_entry_id, v_row.result_number;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_accept_begin(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION share_accept_begin(uuid) TO tm_app;
--> statement-breakpoint
-- Second half: the copies exist (made by the app as the recipient, inside the
-- same transaction); record them, close the share and tell the sender.
CREATE FUNCTION share_accept_finish(p_share uuid, p_entry uuid, p_strategy uuid)
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
  SELECT e.registration_number INTO v_number FROM strategy_library_entries e
   WHERE e.id = p_entry AND e.received_share_id = p_share AND e.registered_by = v_caller;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the copied record is missing' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF (v_row.kind = 'lab') <> (p_strategy IS NOT NULL) OR (p_strategy IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM strategy s
     WHERE s.id = p_strategy AND s.user_id = v_caller AND s.received_share_id = p_share
       AND s.library_entry_id = p_entry
  )) THEN
    RAISE EXCEPTION 'the copied strategy is missing' USING ERRCODE = 'invalid_parameter_value';
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_accept_finish(uuid, uuid, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION share_accept_finish(uuid, uuid, uuid) TO tm_app;
--> statement-breakpoint
-- Declining (the recipient) or withdrawing (the sender) a pending share.
CREATE FUNCTION share_close(p_share uuid, p_status text) RETURNS void
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_caller uuid := share_caller();
  v_row strategy_share;
BEGIN
  IF p_status NOT IN ('declined', 'withdrawn') THEN
    RAISE EXCEPTION 'unknown answer' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  PERFORM set_config('tm.sharing', 'on', true);
  SELECT * INTO v_row FROM strategy_share s
   WHERE s.id = p_share
     AND CASE WHEN p_status = 'declined' THEN s.recipient_id ELSE s.sender_id END = v_caller
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'share not found' USING ERRCODE = 'no_data_found';
  END IF;
  IF v_row.status <> 'pending' THEN
    RAISE EXCEPTION 'this share was already %', v_row.status USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE strategy_share SET status = p_status, decided_at = now() WHERE id = p_share;
  IF p_status = 'declined' THEN
    PERFORM share_notify(
      v_row.sender_id, 'share_declined',
      share_person(v_row.recipient_name, v_row.recipient_code) || ' declined ' || v_row.source_number,
      '', p_share);
    IF v_row.sender_id IS NOT NULL THEN
      INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
      VALUES (v_row.sender_id, 'system', 'share.declined', 'strategy_share', p_share,
              jsonb_build_object('number', v_row.source_number, 'by', v_row.recipient_code));
    END IF;
  ELSIF v_row.recipient_id IS NOT NULL THEN
    INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
    VALUES (v_row.recipient_id, 'system', 'share.withdrawn', 'strategy_share', p_share,
            jsonb_build_object('number', v_row.source_number, 'by', v_row.sender_code));
  END IF;
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES (v_caller, 'user', 'share.' || p_status, 'strategy_share', p_share,
          jsonb_build_object('number', v_row.source_number));
  PERFORM set_config('tm.sharing', '', true);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_close(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION share_close(uuid, text) TO tm_app;
--> statement-breakpoint
-- Pending shares past their 30 days. Anyone may run it (the worker does, daily);
-- it changes nothing but overdue statuses and tells no one.
CREATE FUNCTION share_expire() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_count integer;
BEGIN
  UPDATE strategy_share SET status = 'expired', decided_at = now()
   WHERE status = 'pending' AND expires_at <= now();
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_expire() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION share_expire() TO tm_app;
--> statement-breakpoint
-- Deleting an account: what it sent is withdrawn and what it was sent is
-- declined, silently. Copies already accepted stay with their owners.
CREATE FUNCTION share_close_for_account() RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_caller uuid := share_caller();
  v_sent integer;
  v_received integer;
BEGIN
  UPDATE strategy_share SET status = 'withdrawn', decided_at = now()
   WHERE sender_id = v_caller AND status = 'pending';
  GET DIAGNOSTICS v_sent = ROW_COUNT;
  UPDATE strategy_share SET status = 'declined', decided_at = now()
   WHERE recipient_id = v_caller AND status = 'pending';
  GET DIAGNOSTICS v_received = ROW_COUNT;
  RETURN v_sent + v_received;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION share_close_for_account() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION share_close_for_account() TO tm_app;
--> statement-breakpoint
-- The purge (0048, 0060) also forgets the person's name on shares.
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
