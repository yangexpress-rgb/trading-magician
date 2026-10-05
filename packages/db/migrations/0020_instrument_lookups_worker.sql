-- Instrument lookups (ADR 0017): people ask for a symbol, the worker answers
-- through the tenant's data feed and registers the instrument it finds.
CREATE TRIGGER instrument_lookup_set_updated_at BEFORE UPDATE ON "instrument_lookup"
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
ALTER TABLE "instrument_lookup" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "instrument_lookup" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON "instrument_lookup" TO tm_app
  USING (user_id = app_current_user_id())
  WITH CHECK (user_id = app_current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "instrument_lookup" TO tm_app;
--> statement-breakpoint
GRANT UPDATE (status, instrument_id, message, lease_expires_at, attempts) ON "instrument_lookup" TO tm_app;
--> statement-breakpoint
CREATE TRIGGER instrument_lookup_notify
  AFTER INSERT OR UPDATE OF status ON instrument_lookup
  FOR EACH ROW EXECUTE FUNCTION notify_execution_change();
--> statement-breakpoint
-- The worker claims pending lookups across tenants, then answers each in its tenant's scope.
CREATE FUNCTION claim_instrument_lookups(p_lease_seconds integer, p_limit integer)
  RETURNS TABLE (claimed_id uuid, claimed_user uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
BEGIN
  IF p_lease_seconds NOT BETWEEN 5 AND 3600 OR p_limit NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid queue arguments' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  UPDATE instrument_lookup AS l
     SET lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         attempts = l.attempts + 1
   WHERE l.id IN (
           SELECT c.id FROM instrument_lookup AS c
            WHERE c.status = 'pending'
              AND (c.lease_expires_at IS NULL OR c.lease_expires_at < now())
            ORDER BY c.created_at
            FOR UPDATE SKIP LOCKED
            LIMIT p_limit)
  RETURNING l.id, l.user_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION claim_instrument_lookups(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION claim_instrument_lookups(integer, integer) TO tm_app;
--> statement-breakpoint
-- Instruments are shared reference data the web login can only read. Only the
-- worker (tm_secrets) may add a real US stock or ETF a provider confirmed.
CREATE FUNCTION register_instrument(
    p_asset_class asset_class, p_symbol text, p_venue text, p_display_name text,
    p_provider text, p_provider_id text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid;
BEGIN
  IF p_asset_class NOT IN ('stock', 'etf')
     OR p_symbol !~ '^[A-Z][A-Z0-9.]{0,9}$'
     OR p_venue !~ '^[A-Z]{2,12}$' OR p_venue = 'DEMO'
     OR length(coalesce(p_display_name, '')) NOT BETWEEN 1 AND 200
     OR p_provider !~ '^[a-z]{2,20}$'
     OR length(coalesce(p_provider_id, '')) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid instrument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO instrument (asset_class, symbol, venue, currency, display_name, tick_size, provider_ids)
  VALUES (p_asset_class, p_symbol, p_venue, 'USD', p_display_name, 0.01,
          jsonb_build_object(p_provider, p_provider_id))
  ON CONFLICT ON CONSTRAINT instrument_identity_uq DO UPDATE
     SET display_name = EXCLUDED.display_name,
         provider_ids = instrument.provider_ids || EXCLUDED.provider_ids
   WHERE NOT instrument.is_demo
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'instrument conflicts with a demo instrument' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN v_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION register_instrument(asset_class, text, text, text, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION register_instrument(asset_class, text, text, text, text, text) TO tm_secrets;
