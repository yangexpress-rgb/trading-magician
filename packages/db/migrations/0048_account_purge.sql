-- Account deletion follows the retention policy (§20 #14, design v1.1 C6 and
-- deviation D1): deleting an account marks it (user.deleted_at) and refuses
-- sign-in; 30 days later the worker purges it here. Personal details and
-- everything that is not an order or audit record are removed; order intents,
-- broker orders, order events, fills, positions and the audit trail stay, with
-- the names that could identify the person replaced.
--
-- The function runs as the migration owner. Tables force row-level security,
-- so the owner gets narrow policies that reach only accounts already marked
-- deleted, and only the worker (tm_secrets) may call the function.
DO $$
DECLARE
  t text;
BEGIN
  EXECUTE format('CREATE POLICY purge_owner ON "user" TO %I USING (deleted_at IS NOT NULL) WITH CHECK (deleted_at IS NOT NULL)', current_user);
  FOREACH t IN ARRAY ARRAY['session', 'account'] LOOP
    EXECUTE format(
      'CREATE POLICY purge_owner ON %I TO %I USING (user_id IN (SELECT id FROM "user" WHERE deleted_at IS NOT NULL))',
      t, current_user);
  END LOOP;
  EXECUTE format('CREATE POLICY purge_owner ON "verification" TO %I USING (true)', current_user);
  FOREACH t IN ARRAY ARRAY[
    'profile', 'credential', 'data_feed_connection', 'broker_connection', 'trading_account',
    'strategy', 'backtest_run', 'backtest_trade', 'notification', 'instrument_lookup',
    'price_chart', 'stock_screen', 'company_report'
  ] LOOP
    EXECUTE format(
      'CREATE POLICY purge_owner ON %I TO %I USING (user_id IN (SELECT id FROM "user" WHERE deleted_at IS NOT NULL)) WITH CHECK (user_id IN (SELECT id FROM "user" WHERE deleted_at IS NOT NULL))',
      t, current_user);
  END LOOP;
  EXECUTE format(
    'CREATE POLICY purge_owner ON "audit_event" FOR INSERT TO %I WITH CHECK (user_id IN (SELECT id FROM "user" WHERE deleted_at IS NOT NULL))',
    current_user);
END
$$;
--> statement-breakpoint
CREATE FUNCTION purge_deleted_accounts(p_after_days integer, p_limit integer)
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
       SET credential_ref = NULL, is_active = false, name = 'Deleted feed', last_error = NULL
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
