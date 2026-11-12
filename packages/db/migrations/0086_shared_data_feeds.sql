ALTER TABLE "platform_admin" ADD COLUMN "shares_feeds" boolean DEFAULT true NOT NULL;--> statement-breakpoint
-- Shared data feeds (N237, ADR 0084). A member with no active feed of a kind
-- (prices, company data, options data) uses the feeds of that kind belonging
-- to the oldest platform admin who shares. Only names and providers ever
-- reach the member: keys stay sealed, and only the worker opens them, in the
-- admin's own tenant. This function names that admin, or NULL when none shares.
CREATE FUNCTION shared_feed_owner() RETURNS uuid
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT a.user_id FROM platform_admin AS a
     WHERE a.shares_feeds
     ORDER BY a.granted_at, a.user_id
     LIMIT 1
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION shared_feed_owner() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION shared_feed_owner() TO tm_app;
--> statement-breakpoint
-- The functions below run as the migration owner, which row-level security
-- also binds (the tables force it), so the owner may read only the sharing
-- admin's feeds and routes.
DO $$
BEGIN
  EXECUTE format(
    'CREATE POLICY shared_feeds_read ON "data_feed_connection" FOR SELECT TO %I USING (user_id = shared_feed_owner())',
    current_user);
  EXECUTE format(
    'CREATE POLICY shared_feeds_read ON "data_route" FOR SELECT TO %I USING (user_id = shared_feed_owner())',
    current_user);
END
$$;
--> statement-breakpoint
-- The sharing admin's active feeds: no keys, no settings, no health.
CREATE FUNCTION shared_data_feeds()
  RETURNS TABLE (id uuid, name text, provider text, created_at timestamptz)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT f.id, f.name, f.provider, f.created_at
      FROM data_feed_connection AS f
     WHERE f.user_id = shared_feed_owner() AND f.is_active
     ORDER BY f.created_at, f.id
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION shared_data_feeds() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION shared_data_feeds() TO tm_app;
--> statement-breakpoint
-- What the sharing admin's routes cover, for the builder's "has a feed" check.
CREATE FUNCTION shared_data_routes()
  RETURNS TABLE (asset_class text, data_type text)
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT DISTINCT r.asset_class::text, r.data_type::text
      FROM data_route AS r
      JOIN data_feed_connection AS f ON f.id = r.primary_feed_id
     WHERE r.user_id = shared_feed_owner() AND f.is_active
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION shared_data_routes() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION shared_data_routes() TO tm_app;
--> statement-breakpoint
-- The signed-in admin's own choice, and changing it (audited).
CREATE FUNCTION admin_feed_sharing() RETURNS boolean
  LANGUAGE sql
  STABLE
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    SELECT a.shares_feeds FROM platform_admin AS a WHERE a.user_id = admin_check()
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_feed_sharing() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_feed_sharing() TO tm_app;
--> statement-breakpoint
CREATE FUNCTION admin_set_feed_sharing(p_on boolean) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_admin uuid := admin_check();
  v_changed integer;
BEGIN
  UPDATE platform_admin SET shares_feeds = p_on
   WHERE user_id = v_admin AND shares_feeds IS DISTINCT FROM p_on;
  GET DIAGNOSTICS v_changed = ROW_COUNT;
  IF v_changed = 0 THEN
    RETURN false;
  END IF;
  INSERT INTO audit_event (user_id, actor_type, action, resource_type, resource_id, context)
  VALUES (NULL, 'system',
          CASE WHEN p_on THEN 'admin.feeds_shared' ELSE 'admin.feeds_unshared' END,
          'user', v_admin, jsonb_build_object('adminId', v_admin));
  RETURN true;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION admin_set_feed_sharing(boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION admin_set_feed_sharing(boolean) TO tm_app;
