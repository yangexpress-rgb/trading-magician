CREATE TABLE "option_chain_snapshot" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"contract_id" uuid NOT NULL,
	"underlying_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"underlying_close" numeric,
	"bid" numeric,
	"ask" numeric,
	"last" numeric,
	"volume" integer,
	"open_interest" integer,
	"iv" numeric,
	"delta" numeric,
	"gamma" numeric,
	"vega" numeric,
	"theta" numeric,
	"rho" numeric,
	"theo" numeric,
	"iv_calc" numeric,
	"delta_calc" numeric,
	"gamma_calc" numeric,
	"source" text NOT NULL,
	"feed" text NOT NULL,
	"file_timestamp" timestamp with time zone NOT NULL,
	"fetched_at" timestamp with time zone NOT NULL,
	"data_version" text NOT NULL,
	CONSTRAINT "option_chain_snapshot_uq" UNIQUE("contract_id","as_of_date"),
	CONSTRAINT "option_chain_snapshot_feed" CHECK ("option_chain_snapshot"."feed" in ('cboe', 'opra'))
);
--> statement-breakpoint
CREATE TABLE "option_contract" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"underlying_id" uuid NOT NULL,
	"expiry" date NOT NULL,
	"strike" numeric NOT NULL,
	"right" "option_right" NOT NULL,
	"occ_symbol" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "option_contract_occ_uq" UNIQUE("occ_symbol"),
	CONSTRAINT "option_contract_uq" UNIQUE("underlying_id","expiry","strike","right"),
	CONSTRAINT "option_contract_strike_positive" CHECK ("option_contract"."strike" > 0)
);
--> statement-breakpoint
CREATE TABLE "option_daily_signal" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"underlying_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"iv30" numeric,
	"atm_iv" numeric,
	"expected_move_1d_pct" numeric,
	"expected_move_1d_usd" numeric,
	"expected_move_5d_pct" numeric,
	"expected_move_5d_usd" numeric,
	"straddle_move_pct" numeric,
	"iv_rank_252d" numeric,
	"iv_percentile_252d" numeric,
	"iv_rv_ratio" numeric,
	"skew_30d" numeric,
	"term_structure" numeric,
	"put_call_volume" numeric,
	"put_call_oi" numeric,
	"net_gex" numeric,
	"call_gex" numeric,
	"put_gex" numeric,
	"call_wall" numeric,
	"put_wall" numeric,
	"max_pain" numeric,
	"iv_history_days" integer DEFAULT 0 NOT NULL,
	"underlying_close" numeric,
	"risk_free_rate" numeric,
	"dividend_yield" numeric,
	"source" text NOT NULL,
	"feed" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "option_daily_signal_uq" UNIQUE("underlying_id","as_of_date"),
	CONSTRAINT "option_daily_signal_source" CHECK ("option_daily_signal"."source" in ('recorded', 'rebuilt')),
	CONSTRAINT "option_daily_signal_feed" CHECK ("option_daily_signal"."feed" in ('cboe', 'opra', 'alpaca_bars'))
);
--> statement-breakpoint
CREATE TABLE "option_expiry_signal" (
	"underlying_id" uuid NOT NULL,
	"as_of_date" date NOT NULL,
	"expiry" date NOT NULL,
	"days_to_expiry" integer NOT NULL,
	"atm_iv" numeric,
	"put_iv_25d" numeric,
	"call_iv_25d" numeric,
	"put_volume" integer,
	"call_volume" integer,
	"put_oi" integer,
	"call_oi" integer,
	"source" text NOT NULL,
	"computed_at" timestamp with time zone NOT NULL,
	CONSTRAINT "option_expiry_signal_pk" PRIMARY KEY("underlying_id","as_of_date","expiry"),
	CONSTRAINT "option_expiry_signal_source" CHECK ("option_expiry_signal"."source" in ('recorded', 'rebuilt'))
);
--> statement-breakpoint
CREATE TABLE "option_universe" (
	"underlying_id" uuid PRIMARY KEY NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"added_by" text NOT NULL,
	"last_snapshot_date" date,
	"last_signal_date" date,
	"last_attempt_at" timestamp with time zone,
	"attempt_date" date,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"last_skipped" integer,
	"rebuild_status" text DEFAULT 'pending' NOT NULL,
	"rebuild_note" text,
	"rebuilt_at" timestamp with time zone,
	CONSTRAINT "option_universe_added_by" CHECK ("option_universe"."added_by" in ('seed', 'strategy')),
	CONSTRAINT "option_universe_rebuild_status" CHECK ("option_universe"."rebuild_status" in ('pending', 'running', 'done', 'waiting', 'failed'))
);
--> statement-breakpoint
ALTER TABLE "option_chain_snapshot" ADD CONSTRAINT "option_chain_snapshot_contract_id_option_contract_id_fk" FOREIGN KEY ("contract_id") REFERENCES "public"."option_contract"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_chain_snapshot" ADD CONSTRAINT "option_chain_snapshot_underlying_id_instrument_id_fk" FOREIGN KEY ("underlying_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_contract" ADD CONSTRAINT "option_contract_underlying_id_instrument_id_fk" FOREIGN KEY ("underlying_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_daily_signal" ADD CONSTRAINT "option_daily_signal_underlying_id_instrument_id_fk" FOREIGN KEY ("underlying_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_expiry_signal" ADD CONSTRAINT "option_expiry_signal_underlying_id_instrument_id_fk" FOREIGN KEY ("underlying_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "option_universe" ADD CONSTRAINT "option_universe_underlying_id_instrument_id_fk" FOREIGN KEY ("underlying_id") REFERENCES "public"."instrument"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "option_chain_snapshot_day_idx" ON "option_chain_snapshot" USING btree ("underlying_id","as_of_date");--> statement-breakpoint
-- Options data (options data brief v2, ADR 0047). Public market data kept once
-- for every tenant, like instruments: only the worker (tm_secrets) writes it.
-- The app login may read the universe and the derived signals, which belong to
-- no tenant (so no row-level security, as for instruments). Chains and
-- contracts are for the worker alone (CBOE's terms: no chain is ever shown).
GRANT SELECT, INSERT, UPDATE, DELETE ON "option_universe" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "option_universe" TO tm_app;--> statement-breakpoint
ALTER TABLE "option_contract" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY worker_only ON "option_contract" TO tm_secrets USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "option_contract" TO tm_secrets;--> statement-breakpoint
ALTER TABLE "option_chain_snapshot" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY worker_only ON "option_chain_snapshot" TO tm_secrets USING (true) WITH CHECK (true);--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "option_chain_snapshot" TO tm_secrets;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "option_daily_signal" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "option_daily_signal" TO tm_app;--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "option_expiry_signal" TO tm_secrets;--> statement-breakpoint
GRANT SELECT ON "option_expiry_signal" TO tm_app;--> statement-breakpoint
-- The auto-add rule (brief §2): a US stock or ETF added to a strategy joins the
-- universe. The app login can't write the universe, so it calls this.
CREATE FUNCTION add_option_underlyings(p_ids uuid[])
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public, pg_temp
  AS $$
DECLARE
  added integer;
BEGIN
  IF p_ids IS NULL OR cardinality(p_ids) > 1000 THEN
    RAISE EXCEPTION 'invalid instrument list' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO option_universe (underlying_id, added_by)
  SELECT i.id, 'strategy'
    FROM instrument AS i
   WHERE i.id = ANY (p_ids)
     AND i.asset_class IN ('stock', 'etf')
     AND NOT i.is_demo
  ON CONFLICT (underlying_id) DO NOTHING;
  GET DIAGNOSTICS added = ROW_COUNT;
  RETURN added;
END;
$$;--> statement-breakpoint
REVOKE ALL ON FUNCTION add_option_underlyings(uuid[]) FROM PUBLIC;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION add_option_underlyings(uuid[]) TO tm_app;--> statement-breakpoint
GRANT EXECUTE ON FUNCTION add_option_underlyings(uuid[]) TO tm_secrets;--> statement-breakpoint
-- The seed list (brief §2) where those instruments exist already; the worker
-- registers the rest. Then every US stock and ETF already in a strategy.
INSERT INTO option_universe (underlying_id, added_by)
SELECT DISTINCT ON (i.symbol) i.id, 'seed'
  FROM instrument AS i
 WHERE i.symbol IN ('SPY', 'QQQ', 'DIA', 'IWM', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL',
                    'TSLA', 'AMD', 'NFLX', 'AVGO')
   AND i.asset_class IN ('stock', 'etf')
   AND NOT i.is_demo
 ORDER BY i.symbol, i.created_at
ON CONFLICT (underlying_id) DO NOTHING;--> statement-breakpoint
INSERT INTO option_universe (underlying_id, added_by)
SELECT DISTINCT si.instrument_id, 'strategy'
  FROM strategy_instrument AS si
  JOIN instrument AS i ON i.id = si.instrument_id
 WHERE i.asset_class IN ('stock', 'etf')
   AND NOT i.is_demo
ON CONFLICT (underlying_id) DO NOTHING;
