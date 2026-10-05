-- Trading platforms and accounts (ADR 0018).
-- The demo account's capabilities match the simulated paper broker, which has
-- no extended session, and say it trades the demo instruments only.
UPDATE trading_account AS a
   SET capabilities = a.capabilities || '{"extendedHours": false, "coverage": "demo"}'::jsonb
  FROM broker_connection AS b
 WHERE b.id = a.broker_connection_id AND b.provider = 'demo';
--> statement-breakpoint
-- The worker claims platforms to check (Connect or Test pressed, or an active
-- one not checked recently), then checks each in its tenant's scope.
CREATE FUNCTION claim_broker_checks(p_lease_seconds integer, p_every_seconds integer, p_limit integer)
  RETURNS TABLE (claimed_id uuid, claimed_user uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_every_seconds NOT BETWEEN 10 AND 86400
     OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  UPDATE broker_connection AS b
     SET check_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE b.id IN (
           SELECT c.id FROM broker_connection AS c
            WHERE (c.check_lease_expires_at IS NULL OR c.check_lease_expires_at < now())
              AND (c.check_requested_at IS NOT NULL
                   OR (c.is_active AND (c.last_checked_at IS NULL
                       OR c.last_checked_at < now() - make_interval(secs => p_every_seconds))))
            ORDER BY c.check_requested_at NULLS LAST, c.last_checked_at NULLS FIRST
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING b.id, b.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_broker_checks(integer, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_broker_checks(integer, integer, integer) TO tm_app;
--> statement-breakpoint
CREATE TRIGGER broker_connection_notify
  AFTER INSERT OR UPDATE OF name, is_active, health, last_checked_at, last_error,
    check_requested_at, credential_ref ON broker_connection
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
--> statement-breakpoint
CREATE TRIGGER trading_account_notify
  AFTER INSERT OR UPDATE ON trading_account
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
