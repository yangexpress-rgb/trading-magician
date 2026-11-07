-- Account purge covers custom REST feeds (code review 2026-11-07, M4). The
-- function in 0048 predates them (0053), so a purged account kept its feed
-- tests (configuration and provider answers), cached answers, request counts
-- and each feed's configuration. As in 0048, the owner reaches these tables
-- only for accounts already marked deleted.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['custom_feed_test', 'custom_feed_cache', 'custom_feed_usage'] LOOP
    EXECUTE format(
      'CREATE POLICY purge_owner ON %I TO %I USING (user_id IN (SELECT id FROM "user" WHERE deleted_at IS NOT NULL)) WITH CHECK (user_id IN (SELECT id FROM "user" WHERE deleted_at IS NOT NULL))',
      t, current_user);
  END LOOP;
END
$$;
--> statement-breakpoint
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
--> statement-breakpoint
REVOKE ALL ON FUNCTION purge_deleted_accounts(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION purge_deleted_accounts(integer, integer) TO tm_secrets;
