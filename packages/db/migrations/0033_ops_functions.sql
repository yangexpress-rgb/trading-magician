-- Shared rate limits and worker heartbeats (ADR 0025). The app reaches both
-- only through these functions; it cannot read other people's counters.
CREATE FUNCTION rate_limit_hit(p_key text, p_limit integer, p_window_seconds integer)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_window interval := make_interval(secs => greatest(p_window_seconds, 1));
  v_row api_rate_limit%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) > 200 THEN
    RAISE EXCEPTION 'rate limit key must be 1 to 200 characters'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO api_rate_limit AS r (key, window_start, count)
    VALUES (p_key, now(), 1)
    ON CONFLICT (key) DO UPDATE
      SET window_start = CASE WHEN r.window_start + v_window <= now() THEN now() ELSE r.window_start END,
          count = CASE WHEN r.window_start + v_window <= now() THEN 1 ELSE r.count + 1 END
    RETURNING * INTO v_row;
  IF v_row.count <= p_limit THEN
    RETURN 0;
  END IF;
  RETURN greatest(1, ceil(extract(epoch FROM (v_row.window_start + v_window - now())))::integer);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rate_limit_hit(text, integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rate_limit_hit(text, integer, integer) TO tm_app;
--> statement-breakpoint
-- Old windows are cleared by the worker; nothing depends on them.
CREATE FUNCTION rate_limit_prune(p_older_than_seconds integer)
  RETURNS integer
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    WITH gone AS (
      DELETE FROM api_rate_limit
       WHERE window_start < now() - make_interval(secs => greatest(p_older_than_seconds, 3600))
      RETURNING 1)
    SELECT count(*)::integer FROM gone
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION rate_limit_prune(integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION rate_limit_prune(integer) TO tm_secrets;
--> statement-breakpoint
CREATE FUNCTION record_heartbeat(p_service text, p_instance text)
  RETURNS void
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
    INSERT INTO service_heartbeat (service, instance, beat_at)
      VALUES (left(p_service, 40), left(p_instance, 200), now())
      ON CONFLICT (service) DO UPDATE SET instance = excluded.instance, beat_at = excluded.beat_at
  $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION record_heartbeat(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION record_heartbeat(text, text) TO tm_secrets;
--> statement-breakpoint
GRANT SELECT ON service_heartbeat TO tm_app;
