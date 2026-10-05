-- Invite-only sign-up (ADR 0026). Codes are claimed through these functions,
-- so no role can read or forge the hashes. Claiming is atomic: a code admits
-- one person even if two people submit it at the same moment.
ALTER TABLE "invite" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE FUNCTION claim_invite(p_code_hash char(64))
  RETURNS uuid
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE invite SET claimed_at = now()
     WHERE id = (SELECT id FROM invite
                  WHERE code_hash = p_code_hash
                    AND claimed_at IS NULL
                    AND (expires_at IS NULL OR expires_at > now())
                  FOR UPDATE SKIP LOCKED)
    RETURNING id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_invite(char) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_invite(char) TO tm_auth, tm_app;
--> statement-breakpoint
-- Names the person who used a claimed code, once their account exists.
CREATE FUNCTION attach_invite(p_code_hash char(64), p_user uuid)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE invite SET claimed_by = p_user
     WHERE code_hash = p_code_hash AND claimed_at IS NOT NULL AND claimed_by IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION attach_invite(char, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION attach_invite(char, uuid) TO tm_auth, tm_app;
--> statement-breakpoint
-- Gives a claimed code back when the account it was claimed for was not created.
CREATE FUNCTION release_invite(p_code_hash char(64))
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    UPDATE invite SET claimed_at = NULL WHERE code_hash = p_code_hash AND claimed_by IS NULL
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION release_invite(char) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION release_invite(char) TO tm_auth, tm_app;
