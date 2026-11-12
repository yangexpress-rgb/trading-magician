ALTER TABLE "invite" ADD COLUMN "code_hint" text;--> statement-breakpoint
ALTER TABLE "invite" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "invite" ADD CONSTRAINT "invite_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
-- Only ever the first group of four (N236, ADR 0083): never the whole code.
ALTER TABLE "invite" ADD CONSTRAINT "invite_code_hint" CHECK ("invite"."code_hint" ~ '^[A-Z2-9]{4}$');--> statement-breakpoint
-- Codes minted on the admin page before this migration: the mint wrote one
-- invite.minted event in the same transaction, so its time matches the codes'
-- created_at and its context names the admin.
UPDATE invite i
   SET created_by = (e.context->>'adminId')::uuid
  FROM audit_event e
 WHERE e.action = 'invite.minted'
   AND e.occurred_at = i.created_at
   AND e.context ? 'adminId'
   AND EXISTS (SELECT 1 FROM "user" u WHERE u.id = (e.context->>'adminId')::uuid);
--> statement-breakpoint
DROP FUNCTION admin_mint_invites(char(64)[], text, timestamptz);
--> statement-breakpoint
-- p_code_hints runs parallel to p_code_hashes: each code's first group of four.
CREATE FUNCTION admin_mint_invites(p_code_hashes char(64)[], p_code_hints text[], p_note text, p_expires_at timestamptz)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_admin uuid := admin_check();
  v_count integer := coalesce(array_length(p_code_hashes, 1), 0);
BEGIN
  IF v_count < 1 OR v_count > 50 THEN
    RAISE EXCEPTION 'mint between 1 and 50 codes' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF coalesce(array_length(p_code_hints, 1), 0) <> v_count THEN
    RAISE EXCEPTION 'one hint per code' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO invite (code_hash, code_hint, note, expires_at, created_by)
  SELECT h.hash, h.hint, nullif(p_note, ''), p_expires_at, v_admin
    FROM unnest(p_code_hashes, p_code_hints) AS h(hash, hint);
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, context)
  VALUES (NULL, 'system', 'invite.minted', 'invite',
          jsonb_build_object('count', v_count, 'note', nullif(p_note, ''),
                             'expiresAt', p_expires_at, 'adminId', v_admin));
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_mint_invites(char[], text[], text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_mint_invites(char[], text[], text, timestamptz) TO tm_app;
--> statement-breakpoint
DROP FUNCTION admin_list_invites();
--> statement-breakpoint
CREATE FUNCTION admin_list_invites()
  RETURNS TABLE (
    id uuid, note text, created_at timestamptz, expires_at timestamptz,
    claimed_at timestamptz, claimed_by uuid, claimed_by_email text,
    code_hint text, created_by uuid, created_by_email text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  PERFORM admin_check();
  RETURN QUERY
    SELECT i.id, i.note, i.created_at, i.expires_at, i.claimed_at, i.claimed_by, u.email,
           i.code_hint, i.created_by, c.email
      FROM invite i
      LEFT JOIN "user" u ON u.id = i.claimed_by
      LEFT JOIN "user" c ON c.id = i.created_by
     ORDER BY i.created_at DESC;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_list_invites() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_list_invites() TO tm_app;
