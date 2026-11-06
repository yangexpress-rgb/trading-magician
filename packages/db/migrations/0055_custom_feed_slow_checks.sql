-- Design v1.2 N24: a custom REST feed with a daily limit under 3,000 is
-- health-checked every 15 minutes instead of every minute, so the checks do
-- not use up a small free tier. Mirrors CUSTOM_REST_LIMITS.smallDailyLimit
-- and slowCheckSeconds in @tm/domain. Same signature, so grants are kept.
CREATE OR REPLACE FUNCTION claim_feed_checks(p_lease_seconds integer, p_every_seconds integer, p_limit integer)
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
                       OR c.last_checked_at < now() - make_interval(secs =>
                            CASE WHEN c.provider = 'custom_rest'
                                  AND jsonb_typeof(c.config -> 'limits' -> 'requestsPerDay') = 'number'
                                  AND (c.config -> 'limits' ->> 'requestsPerDay')::numeric < 3000
                                 THEN greatest(p_every_seconds, 900)
                                 ELSE p_every_seconds END))))
            ORDER BY c.check_requested_at NULLS LAST, c.last_checked_at NULLS FIRST
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING f.id, f.user_id;
END
$$;
