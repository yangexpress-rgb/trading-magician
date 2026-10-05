-- Demo instruments have their own venue, so routes for the demo feed name it
-- explicitly; any-venue routes are then free for real providers (ADR 0016).
UPDATE data_route AS r SET venue = 'DEMO'
  FROM data_feed_connection AS f
 WHERE f.id = r.primary_feed_id AND f.provider = 'demo' AND r.venue IS NULL;
--> statement-breakpoint
-- Feed checks and live updates for Settings (ADR 0016).
-- The worker claims feeds to check across tenants (a "Test" request, or an
-- active feed not checked recently), then checks each in its tenant's scope.
CREATE FUNCTION claim_feed_checks(p_lease_seconds integer, p_every_seconds integer, p_limit integer)
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
  UPDATE data_feed_connection AS f
     SET check_lease_expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE f.id IN (
           SELECT c.id FROM data_feed_connection AS c
            WHERE (c.check_lease_expires_at IS NULL OR c.check_lease_expires_at < now())
              AND (c.check_requested_at IS NOT NULL
                   OR (c.is_active AND (c.last_checked_at IS NULL
                       OR c.last_checked_at < now() - make_interval(secs => p_every_seconds))))
            ORDER BY c.check_requested_at NULLS LAST, c.last_checked_at NULLS FIRST
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING f.id, f.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_feed_checks(integer, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_feed_checks(integer, integer, integer) TO tm_app;
--> statement-breakpoint
-- Lease renewals alone do not notify.
CREATE TRIGGER data_feed_connection_notify
  AFTER INSERT OR UPDATE OF name, is_active, health, entitlement, last_checked_at, last_error,
    check_requested_at, credential_ref ON data_feed_connection
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
--> statement-breakpoint
CREATE TRIGGER data_route_notify
  AFTER INSERT OR UPDATE ON data_route
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
