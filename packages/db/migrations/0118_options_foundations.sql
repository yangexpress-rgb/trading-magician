ALTER TABLE "strategy_runtime" ADD COLUMN "trades_options" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "trading_account" ADD COLUMN "broker_options_level" smallint;--> statement-breakpoint
ALTER TABLE "trading_account" ADD CONSTRAINT "trading_account_options_level" CHECK ("trading_account"."broker_options_level" is null or "trading_account"."broker_options_level" between 0 and 3);--> statement-breakpoint
-- Options brief v0.2 §5.3 (ADR 0123): an option contract the resolver picks is
-- an instrument row like any stock, inserted or found on the instrument
-- identity key, so two runs resolving the same contract at once get the same
-- row. Orders, the ledger and reconciliation then know contract holdings as
-- the app's own. The worker (tm_secrets) only; never the web.
CREATE FUNCTION register_option_contract(
    p_underlying_id uuid, p_symbol text, p_expiry date, p_strike numeric,
    p_right option_right, p_multiplier numeric, p_provider text, p_provider_id text)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid;
  v_root text;
BEGIN
  SELECT symbol INTO v_root FROM instrument
   WHERE id = p_underlying_id AND asset_class::text IN ('stock', 'etf') AND NOT is_demo;
  IF v_root IS NULL
     OR p_symbol !~ '^[A-Z][A-Z0-9]{0,5}[0-9]{6}[CP][0-9]{8}$'
     OR p_strike IS NULL OR p_strike <= 0
     OR p_multiplier IS NULL OR p_multiplier <= 0
     OR p_expiry IS NULL
     OR p_provider !~ '^[a-z]{2,20}$'
     OR length(coalesce(p_provider_id, '')) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid option contract' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO instrument (asset_class, symbol, venue, currency, display_name, tick_size,
                          multiplier, underlying_id, expiry, strike, option_right, provider_ids)
  VALUES ('option', p_symbol, 'OPRA', 'USD',
          v_root || ' ' || trim_scale(p_strike)::text || ' ' || p_right::text || ' ' || p_expiry::text,
          0.01, p_multiplier, p_underlying_id, p_expiry, p_strike, p_right,
          jsonb_build_object(p_provider, p_provider_id))
  ON CONFLICT ON CONSTRAINT instrument_identity_uq DO UPDATE
     SET provider_ids = instrument.provider_ids || EXCLUDED.provider_ids
  RETURNING id INTO v_id;
  RETURN v_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION register_option_contract(uuid, text, date, numeric, option_right, numeric, text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION register_option_contract(uuid, text, date, numeric, option_right, numeric, text, text) TO tm_secrets;
