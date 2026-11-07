ALTER TABLE "backtest_trade" ADD COLUMN "direction" text;--> statement-breakpoint
ALTER TABLE "backtest_trade" ADD COLUMN "entry_group" text;--> statement-breakpoint
ALTER TABLE "instrument" ADD COLUMN "shortable" boolean;--> statement-breakpoint
ALTER TABLE "backtest_trade" ADD CONSTRAINT "backtest_trade_direction" CHECK ("backtest_trade"."direction" is null or "backtest_trade"."direction" in ('long', 'short'));--> statement-breakpoint
-- v1.2 item 8: instruments remember whether the broker lends them for short
-- selling, as the provider last said (null when it doesn't say).
DROP FUNCTION register_instrument(asset_class, text, text, text, text, text);
--> statement-breakpoint
CREATE FUNCTION register_instrument(
    p_asset_class asset_class, p_symbol text, p_venue text, p_display_name text,
    p_provider text, p_provider_id text, p_shortable boolean)
  RETURNS uuid
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  v_id uuid;
  v_index boolean := p_asset_class::text = 'index';
BEGIN
  IF p_asset_class::text NOT IN ('stock', 'etf', 'index')
     OR (v_index AND (p_venue <> 'CBOE' OR p_provider <> 'cboe'))
     OR p_symbol !~ '^[A-Z][A-Z0-9.]{0,9}$'
     OR p_venue !~ '^[A-Z]{2,12}$' OR p_venue = 'DEMO'
     OR length(coalesce(p_display_name, '')) NOT BETWEEN 1 AND 200
     OR p_provider !~ '^[a-z]{2,20}$'
     OR length(coalesce(p_provider_id, '')) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'invalid instrument' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO instrument (asset_class, symbol, venue, currency, display_name, tick_size, provider_ids, kind, shortable)
  VALUES (p_asset_class, p_symbol, p_venue, 'USD', p_display_name, 0.01,
          jsonb_build_object(p_provider, p_provider_id),
          CASE WHEN v_index THEN 'indicator_only'::instrument_kind ELSE 'tradable'::instrument_kind END,
          CASE WHEN v_index THEN NULL ELSE p_shortable END)
  ON CONFLICT ON CONSTRAINT instrument_identity_uq DO UPDATE
     SET display_name = EXCLUDED.display_name,
         provider_ids = instrument.provider_ids || EXCLUDED.provider_ids,
         shortable = coalesce(EXCLUDED.shortable, instrument.shortable)
   WHERE NOT instrument.is_demo
  RETURNING id INTO v_id;
  IF v_id IS NULL THEN
    RAISE EXCEPTION 'instrument conflicts with a demo instrument' USING ERRCODE = 'unique_violation';
  END IF;
  RETURN v_id;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION register_instrument(asset_class, text, text, text, text, text, boolean) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION register_instrument(asset_class, text, text, text, text, text, boolean) TO tm_secrets;
