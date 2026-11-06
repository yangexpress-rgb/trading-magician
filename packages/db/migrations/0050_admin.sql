CREATE TABLE "platform_admin" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "locked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform_admin" ADD CONSTRAINT "platform_admin_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- The admin page (ADR 0037). The web app keeps only its tm_app and tm_auth
-- logins; every admin action is one of the functions below, which run as the
-- migration owner and first check that the signed-in caller (app.user_id, set
-- by withTenant from the server-side session) is in platform_admin. Nobody can
-- make an admin from the app: platform_admin has no grants, and rows are
-- written only by the users:grant-admin command with the owner connection.
CREATE FUNCTION is_platform_admin() RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT EXISTS (SELECT 1 FROM platform_admin WHERE user_id = app_current_user_id())
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION is_platform_admin() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION is_platform_admin() TO tm_app;
--> statement-breakpoint
-- Tables force row-level security, so the owner gets policies that open only
-- while an admin is the caller (as with the purge policies in 0048).
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['user', 'session', 'account'] LOOP
    EXECUTE format(
      'CREATE POLICY admin_owner ON %I TO %I USING (is_platform_admin()) WITH CHECK (is_platform_admin())',
      t, current_user);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['entitlement', 'strategy'] LOOP
    EXECUTE format(
      'CREATE POLICY admin_read ON %I FOR SELECT TO %I USING (is_platform_admin())',
      t, current_user);
  END LOOP;
  EXECUTE format(
    'CREATE POLICY admin_read ON "audit_event" FOR SELECT TO %I USING (is_platform_admin())',
    current_user);
  EXECUTE format(
    'CREATE POLICY admin_append ON "audit_event" FOR INSERT TO %I WITH CHECK (is_platform_admin() AND actor_type = %L)',
    current_user, 'system');
END
$$;
--> statement-breakpoint
CREATE FUNCTION admin_check() RETURNS uuid
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'admin only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN app_current_user_id();
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_check() FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION admin_list_users()
  RETURNS TABLE (
    id uuid, email text, name text, created_at timestamptz, deleted_at timestamptz,
    locked_at timestamptz, is_admin boolean, plan_code text, strategies integer,
    running_strategies integer, last_seen_at timestamptz, invite_note text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  PERFORM admin_check();
  RETURN QUERY
    SELECT u.id, u.email, u.name, u.created_at, u.deleted_at, u.locked_at,
           EXISTS (SELECT 1 FROM platform_admin a WHERE a.user_id = u.id),
           e.plan_code,
           (SELECT count(*)::int FROM strategy s WHERE s.user_id = u.id AND s.deleted_at IS NULL),
           (SELECT count(*)::int FROM strategy s
             WHERE s.user_id = u.id AND s.deleted_at IS NULL
               AND s.status IN ('under_testing', 'actively_executing')),
           (SELECT max(se.updated_at) FROM "session" se WHERE se.user_id = u.id),
           (SELECT i.note FROM invite i WHERE i.claimed_by = u.id ORDER BY i.claimed_at DESC LIMIT 1)
      FROM "user" u
      LEFT JOIN entitlement e ON e.user_id = u.id
     ORDER BY u.created_at DESC;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_list_users() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_list_users() TO tm_app;
--> statement-breakpoint
-- Locks or unlocks someone's access. Locking ends every session at once and
-- sign-in is refused until unlocked. An admin cannot lock themselves or another
-- admin (revoke admin first, from the command line). Returns whether anything
-- changed; a change is audited twice: as an operator event naming the admin,
-- and in the person's own trail.
CREATE FUNCTION admin_set_user_locked(p_user uuid, p_locked boolean)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_admin uuid := admin_check();
  v_changed integer;
BEGIN
  IF p_user = v_admin THEN
    RAISE EXCEPTION 'you cannot lock your own account' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_locked AND EXISTS (SELECT 1 FROM platform_admin WHERE user_id = p_user) THEN
    RAISE EXCEPTION 'admins cannot be locked' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_locked THEN
    UPDATE "user" SET locked_at = now()
     WHERE id = p_user AND locked_at IS NULL AND deleted_at IS NULL;
  ELSE
    UPDATE "user" SET locked_at = NULL WHERE id = p_user AND locked_at IS NOT NULL;
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed = 0 THEN
    RETURN false;
  END IF;
  IF p_locked THEN
    DELETE FROM "session" WHERE user_id = p_user;
  END IF;
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES
    (NULL, 'system', CASE WHEN p_locked THEN 'admin.user_locked' ELSE 'admin.user_unlocked' END,
     'user', p_user, jsonb_build_object('adminId', v_admin)),
    (p_user, 'system', CASE WHEN p_locked THEN 'account.locked_by_admin' ELSE 'account.unlocked_by_admin' END,
     'user', p_user, '{}'::jsonb);
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_set_user_locked(uuid, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_set_user_locked(uuid, boolean) TO tm_app;
--> statement-breakpoint
-- Sets a temporary password (hashed by the app; never seen here in plain text)
-- and signs the person out everywhere, as users:reset-password does (ADR 0036).
CREATE FUNCTION admin_reset_password(p_user uuid, p_password_hash text)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_admin uuid := admin_check();
  v_changed integer;
BEGIN
  IF p_user = v_admin THEN
    RAISE EXCEPTION 'change your own password in Settings' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  UPDATE "account" a SET password = p_password_hash, updated_at = now()
    FROM "user" u
   WHERE a.user_id = p_user AND a.provider_id = 'credential'
     AND u.id = a.user_id AND u.deleted_at IS NULL;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed = 0 THEN
    RETURN false;
  END IF;
  DELETE FROM "session" WHERE user_id = p_user;
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES
    (NULL, 'system', 'admin.password_reset', 'user', p_user, jsonb_build_object('adminId', v_admin)),
    (p_user, 'system', 'account.password_reset_by_operator', 'user', p_user, '{}'::jsonb);
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_reset_password(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_reset_password(uuid, text) TO tm_app;
--> statement-breakpoint
-- Stores freshly minted invite codes by hash (the codes are shown to the admin
-- once and never stored or audited, ADR 0034).
CREATE FUNCTION admin_mint_invites(p_code_hashes char(64)[], p_note text, p_expires_at timestamptz)
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
  INSERT INTO invite (code_hash, note, expires_at)
  SELECT h, nullif(p_note, ''), p_expires_at FROM unnest(p_code_hashes) AS h;
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, context)
  VALUES (NULL, 'system', 'invite.minted', 'invite',
          jsonb_build_object('count', v_count, 'note', nullif(p_note, ''),
                             'expiresAt', p_expires_at, 'adminId', v_admin));
  RETURN v_count;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_mint_invites(char[], text, timestamptz) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_mint_invites(char[], text, timestamptz) TO tm_app;
--> statement-breakpoint
CREATE FUNCTION admin_list_invites()
  RETURNS TABLE (
    id uuid, note text, created_at timestamptz, expires_at timestamptz,
    claimed_at timestamptz, claimed_by uuid, claimed_by_email text
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  PERFORM admin_check();
  RETURN QUERY
    SELECT i.id, i.note, i.created_at, i.expires_at, i.claimed_at, i.claimed_by, u.email
      FROM invite i
      LEFT JOIN "user" u ON u.id = i.claimed_by
     ORDER BY i.created_at DESC;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_list_invites() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_list_invites() TO tm_app;
--> statement-breakpoint
-- Frees a code whose sign-up never finished (claimed, but no account), or
-- revokes a code nobody has used yet, so it can no longer admit anyone.
CREATE FUNCTION admin_change_invite(p_invite uuid, p_change text)
  RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_admin uuid := admin_check();
  v_changed integer;
BEGIN
  IF p_change = 'release' THEN
    UPDATE invite SET claimed_at = NULL
     WHERE id = p_invite AND claimed_at IS NOT NULL AND claimed_by IS NULL;
  ELSIF p_change = 'revoke' THEN
    UPDATE invite SET expires_at = now()
     WHERE id = p_invite AND claimed_at IS NULL AND (expires_at IS NULL OR expires_at > now());
  ELSE
    RAISE EXCEPTION 'unknown invite change' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES (NULL, 'system', CASE WHEN p_change = 'release' THEN 'invite.released' ELSE 'invite.revoked' END,
          'invite', p_invite, jsonb_build_object('count', v_changed, 'adminId', v_admin));
  RETURN v_changed > 0;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_change_invite(uuid, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_change_invite(uuid, text) TO tm_app;
--> statement-breakpoint
-- The whole audit trail, newest first, a page at a time. p_action filters by
-- prefix ('invite.', 'admin.', 'account.'), p_user to one person's trail.
CREATE FUNCTION admin_audit_events(p_limit integer, p_before timestamptz, p_action text, p_user uuid)
  RETURNS TABLE (
    id uuid, occurred_at timestamptz, actor_type text, action text, resource_type text,
    resource_id uuid, user_id uuid, user_email text, context jsonb
  )
  LANGUAGE plpgsql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  PERFORM admin_check();
  RETURN QUERY
    SELECT ev.id, ev.occurred_at, ev.actor_type::text, ev.action, ev.resource_type,
           ev.resource_id, ev.user_id, u.email, ev.context
      FROM audit_event ev
      LEFT JOIN "user" u ON u.id = ev.user_id
     WHERE (p_before IS NULL OR ev.occurred_at < p_before)
       AND (p_action IS NULL OR p_action = '' OR ev.action LIKE replace(replace(p_action, '%', ''), '_', '\_') || '%')
       AND (p_user IS NULL OR ev.user_id = p_user)
     ORDER BY ev.occurred_at DESC, ev.id DESC
     LIMIT least(greatest(coalesce(p_limit, 100), 1), 500);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_audit_events(integer, timestamptz, text, uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_audit_events(integer, timestamptz, text, uuid) TO tm_app;
