ALTER TABLE "invite" ADD COLUMN "code_sealed" text;--> statement-breakpoint
-- Whole codes, sealed by the web app (N238, ADR 0085). p_code_sealed is NULL
-- or runs parallel to p_code_hashes.
DROP FUNCTION admin_mint_invites(char(64)[], text[], text, timestamptz);
--> statement-breakpoint
CREATE FUNCTION admin_mint_invites(p_code_hashes char(64)[], p_code_hints text[], p_code_sealed text[], p_note text, p_expires_at timestamptz)
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
  IF coalesce(array_length(p_code_hints, 1), 0) <> v_count
     OR (p_code_sealed IS NOT NULL AND coalesce(array_length(p_code_sealed, 1), 0) <> v_count) THEN
    RAISE EXCEPTION 'one hint and one sealed code per code' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO invite (code_hash, code_hint, code_sealed, note, expires_at, created_by)
  SELECT h.hash, h.hint, p_code_sealed[h.n], nullif(p_note, ''), p_expires_at, v_admin
    FROM unnest(p_code_hashes, p_code_hints) WITH ORDINALITY AS h(hash, hint, n);
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, context)
  VALUES (NULL, 'system', 'invite.minted', 'invite',
          jsonb_build_object('count', v_count, 'note', nullif(p_note, ''),
                             'expiresAt', p_expires_at, 'adminId', v_admin));
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_mint_invites(char[], text[], text[], text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_mint_invites(char[], text[], text[], text, timestamptz) TO tm_app;
--> statement-breakpoint
DROP FUNCTION admin_list_invites();
--> statement-breakpoint
CREATE FUNCTION admin_list_invites()
  RETURNS TABLE (
    id uuid, note text, created_at timestamptz, expires_at timestamptz,
    claimed_at timestamptz, claimed_by uuid, claimed_by_email text,
    code_hint text, created_by uuid, created_by_email text, code_sealed text
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
           i.code_hint, i.created_by, c.email, i.code_sealed
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
