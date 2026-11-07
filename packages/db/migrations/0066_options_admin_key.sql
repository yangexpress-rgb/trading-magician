-- The options recording's Alpaca key (ADR 0047, as changed by ADR 0050). When the
-- worker has no OPTIONS_ALPACA_* key of its own, it falls back to a platform
-- admin's Alpaca paper feed. platform_admin has no grants, so the worker asks
-- this function for the admins, oldest first. It returns user ids only.
CREATE FUNCTION options_key_admins() RETURNS TABLE (user_id uuid)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT a.user_id FROM platform_admin AS a ORDER BY a.granted_at, a.user_id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION options_key_admins() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION options_key_admins() TO tm_secrets;
