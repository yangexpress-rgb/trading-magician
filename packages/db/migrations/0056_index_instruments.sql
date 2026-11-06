-- Design v1.2 item 5 (N30, ADR 0042): indicator-only instruments. An index such
-- as the VIX can be watched by conditions, ranking metrics and calculated
-- expressions, but no leg, order or broker account route can trade it.
CREATE TYPE "public"."instrument_kind" AS ENUM('tradable', 'indicator_only');--> statement-breakpoint
ALTER TYPE "public"."asset_class" ADD VALUE 'index';--> statement-breakpoint
ALTER TABLE "instrument" ADD COLUMN "kind" "instrument_kind" DEFAULT 'tradable' NOT NULL;--> statement-breakpoint
ALTER TABLE "instrument" ADD CONSTRAINT "instrument_index_kind" CHECK (("instrument"."asset_class"::text = 'index') = ("instrument"."kind" = 'indicator_only'));--> statement-breakpoint
-- The worker may now also register an index the app knows (CBOE's), always
-- indicator-only. Same signature, so the grants are kept.
CREATE OR REPLACE FUNCTION register_instrument(
    p_asset_class asset_class, p_symbol text, p_venue text, p_display_name text,
    p_provider text, p_provider_id text)
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

  INSERT INTO instrument (asset_class, symbol, venue, currency, display_name, tick_size, provider_ids, kind)
  VALUES (p_asset_class, p_symbol, p_venue, 'USD', p_display_name, 0.01,
          jsonb_build_object(p_provider, p_provider_id),
          CASE WHEN v_index THEN 'indicator_only'::instrument_kind ELSE 'tradable'::instrument_kind END)
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
